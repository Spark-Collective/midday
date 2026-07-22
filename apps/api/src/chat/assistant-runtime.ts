import { google } from "@ai-sdk/google";
import {
  buildPrepareStep,
  createExecutionClient,
  ensureToolIndex,
  getSearchTool,
  getToolDefinitions,
} from "@api/chat/tools";
import { getComposioTools } from "@api/composio/client";
import type { McpContext } from "@api/mcp/types";
import { logger } from "@midday/logger";
import {
  type ModelMessage,
  smoothStream,
  stepCountIs,
  ToolLoopAgent,
} from "ai";

export async function streamMiddayAssistant(params: {
  mcpCtx: McpContext;
  systemPrompt: string;
  modelMessages: Array<ModelMessage>;
}) {
  const { mcpCtx, systemPrompt, modelMessages } = params;

  await ensureToolIndex(mcpCtx);

  const [resolvedClient, composioMetaTools] = await Promise.all([
    createExecutionClient(mcpCtx),
    getComposioTools(mcpCtx.userId),
  ]);

  let closed = false;
  const closeClient = async () => {
    if (closed) return;
    closed = true;
    await resolvedClient.close().catch(() => {});
  };

  try {
    const mcpTools = resolvedClient.toolsFromDefinitions(getToolDefinitions());
    const composioToolNames = Object.keys(composioMetaTools);

    if (composioToolNames.length > 0) {
      logger.info("[chat] Composio tools available:", {
        tools: composioToolNames,
      });
    }

    const agent = new ToolLoopAgent({
      // Gemini (the box's only LLM key). No web_search: Gemini rejects its
      // search-grounding tool alongside function calling in one request.
      model: google("gemini-2.5-flash"),
      instructions: systemPrompt,
      tools: {
        ...mcpTools,
        ...composioMetaTools,
        search_tools: getSearchTool(),
      },
      prepareStep: buildPrepareStep({
        maxTools: 12,
        alwaysActive: ["search_tools", ...composioToolNames],
      }),
      stopWhen: stepCountIs(10),
      onFinish: closeClient,
    });

    const result = await agent.stream({
      messages: modelMessages,
      experimental_transform: smoothStream(),
    });

    return Object.assign(result, { cleanup: closeClient });
  } catch (error) {
    await closeClient();
    throw error;
  }
}
