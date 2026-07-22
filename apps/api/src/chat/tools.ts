import { google } from "@ai-sdk/google";
import type { MCPClient } from "@ai-sdk/mcp";
import { createMCPClient } from "@ai-sdk/mcp";

import { createMcpServer } from "@api/mcp/server";
import type { McpContext } from "@api/mcp/types";
import { expandScopes } from "@api/utils/scopes";
import { logger } from "@midday/logger";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { PrepareStepFunction, Tool } from "ai";
import type { ToolIndex } from "toolpick";
import { createToolIndex, fileCache } from "toolpick";

// Gemini's batchEmbedContents API caps at 100 requests per call, but
// @ai-sdk/google declares maxEmbeddingsPerCall = 2048 and happily overflows
// it ("at most 100 requests can be in one batch" — this killed every bot
// message during tool-index warm-up). Wrap the model to chunk transparently,
// whether the caller respects maxEmbeddingsPerCall or hits doEmbed directly.
const GEMINI_EMBED_BATCH = 100;

function chunkedGeminiEmbedding() {
  const base = google.embeddingModel("gemini-embedding-001");
  const wrapper = Object.create(
    Object.getPrototypeOf(base),
    Object.getOwnPropertyDescriptors(base),
  );
  wrapper.maxEmbeddingsPerCall = GEMINI_EMBED_BATCH;
  wrapper.doEmbed = async (
    options: Parameters<typeof base.doEmbed>[0],
  ): Promise<Awaited<ReturnType<typeof base.doEmbed>>> => {
    const { values } = options;
    if (values.length <= GEMINI_EMBED_BATCH) {
      return base.doEmbed(options);
    }
    const embeddings: Awaited<ReturnType<typeof base.doEmbed>>["embeddings"] =
      [];
    let tokens = 0;
    let last: Awaited<ReturnType<typeof base.doEmbed>> | undefined;
    for (let i = 0; i < values.length; i += GEMINI_EMBED_BATCH) {
      last = await base.doEmbed({
        ...options,
        values: values.slice(i, i + GEMINI_EMBED_BATCH),
      });
      embeddings.push(...last.embeddings);
      tokens += last.usage?.tokens ?? 0;
    }
    return { ...last!, embeddings, usage: { tokens } };
  };
  return wrapper as typeof base;
}

export type ChatMCPClient = Awaited<ReturnType<typeof createMCPClient>>;
type ToolDefinitions = Awaited<ReturnType<MCPClient["listTools"]>>;

let cachedDefinitions: ToolDefinitions | null = null;
let cachedIndex: ToolIndex<any> | null = null;
let inflightIndexPromise: Promise<ToolIndex<any>> | null = null;

async function bootstrapTools(ctx: McpContext) {
  const mcpServer = createMcpServer(ctx);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await mcpServer.connect(serverTransport);

  const client = await createMCPClient({
    transport: clientTransport,
    name: "midday-bootstrap",
  });

  const definitions = await client.listTools();
  const tools = client.toolsFromDefinitions(definitions);
  await client.close();

  return { definitions, tools };
}

export function ensureToolIndex(ctx: McpContext): Promise<ToolIndex<any>> {
  if (cachedIndex) return Promise.resolve(cachedIndex);
  if (inflightIndexPromise) return inflightIndexPromise;

  inflightIndexPromise = (async () => {
    const { definitions, tools } = await bootstrapTools(ctx);
    cachedDefinitions = definitions;

    const index = await createToolIndex(tools, {
      embeddingModel: chunkedGeminiEmbedding(),
      embeddingCache: fileCache(".toolpick-cache.json"),
      relatedTools: {
        invoices_create: ["customers_list"],
        invoices_create_from_tracker: ["customers_list"],
        invoice_recurring_create: ["customers_list"],
        tracker_timer_start: ["tracker_projects_list"],
        tracker_entries_create: ["tracker_projects_list"],
        tracker_entries_list: ["tracker_projects_list"],
        tracker_projects_list: ["tracker_entries_list"],
        transactions_update: ["categories_list"],
      },
    });

    await index.warmUp();

    cachedIndex = index;
    return index;
  })().catch((err) => {
    inflightIndexPromise = null;
    throw err;
  });

  return inflightIndexPromise;
}

export function getToolDefinitions(): ToolDefinitions {
  if (!cachedDefinitions) {
    throw new Error(
      "Tool definitions not bootstrapped — call ensureToolIndex first",
    );
  }
  return cachedDefinitions;
}

/**
 * Build a prepareStep function that delegates to the cached tool index
 * but guarantees `alwaysActive` tool names are always exposed to the model.
 *
 * Toolpick's own `alwaysActive` option filters names against the index,
 * which excludes built-in provider tools like `web_search`. This wrapper
 * appends them after selection so they're never dropped.
 */
export function buildPrepareStep<T extends Record<string, Tool>>(options: {
  maxTools: number;
  alwaysActive?: string[];
}): PrepareStepFunction<T> {
  if (!cachedIndex) {
    throw new Error("Tool index not bootstrapped — call ensureToolIndex first");
  }

  const base = cachedIndex.prepareStep({ maxTools: options.maxTools });
  const always = options.alwaysActive ?? [];

  return (async (stepOptions: any) => {
    const step = await base(stepOptions);
    if (step?.activeTools && always.length > 0) {
      for (const name of always) {
        if (!step.activeTools.includes(name)) {
          step.activeTools.push(name);
        }
      }
    }
    return step;
  }) as PrepareStepFunction<T>;
}

export function getSearchTool() {
  if (!cachedIndex) {
    throw new Error("Tool index not bootstrapped — call ensureToolIndex first");
  }
  return cachedIndex.searchTool();
}

/**
 * Pre-warm the tool index at server startup so the first chat request
 * doesn't pay the MCP bootstrap + embedding cost. Safe to call multiple
 * times — subsequent calls are no-ops once the index is cached.
 */
export function warmToolIndex(): void {
  const stubCtx: McpContext = {
    db: {} as McpContext["db"],
    teamId: "warmup",
    userId: "warmup",
    userEmail: null,
    scopes: expandScopes(["apis.all"]) as McpContext["scopes"],
    apiUrl: process.env.MIDDAY_API_URL ?? "https://api.midday.ai",
    timezone: "UTC",
    locale: "en",
    countryCode: null,
    dateFormat: null,
    timeFormat: 24,
  };

  ensureToolIndex(stubCtx).catch((err) => {
    logger.warn(
      "[chat] Tool index warm-up failed (will retry on first request)",
      {
        error: err instanceof Error ? err.message : String(err),
      },
    );
  });
}

export async function createExecutionClient(ctx: McpContext) {
  const mcpServer = createMcpServer(ctx);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);
  return createMCPClient({
    transport: clientTransport,
    name: "midday-chat",
  });
}
