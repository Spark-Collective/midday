/**
 * Web search for the assistant, as a real tool.
 *
 * The system prompt routes external questions (prices, exchange rates, tax
 * rates, benchmarks) to `web_search`, but no such tool was ever registered:
 * Gemini refuses its search-grounding tool in the same request as function
 * calling, so it was dropped from the agent and the instruction was left
 * pointing at nothing. The model then answered those questions from memory,
 * confidently and without sources — the worst possible outcome for anything
 * rate- or rule-shaped.
 *
 * The conflict is per REQUEST, not per conversation. So this tool runs its
 * own grounded call: one Gemini request carrying googleSearch and no
 * function tools, whose text and sources come back as the tool result. Same
 * API key, no extra provider.
 */
import { google } from "@ai-sdk/google";
import { logger } from "@midday/logger";
import { generateText, tool } from "ai";
import { z } from "zod";

export type WebSearchResult = {
  answer: string;
  sources: Array<{ title: string; url: string }>;
};

/** Grounding returns one entry per citation, so the same page repeats. */
export function dedupeSources(
  raw: Array<{ url?: string; title?: string }> | undefined,
): WebSearchResult["sources"] {
  const seen = new Set<string>();
  const sources: WebSearchResult["sources"] = [];
  for (const s of raw ?? []) {
    if (!s?.url || seen.has(s.url)) continue;
    seen.add(s.url);
    sources.push({ title: s.title || s.url, url: s.url });
  }
  return sources;
}

export async function runWebSearch(query: string): Promise<WebSearchResult> {
  const result = await generateText({
    model: google("gemini-2.5-flash"),
    tools: { google_search: google.tools.googleSearch({}) },
    prompt: [
      "Search the web and answer with current, factual information.",
      "State figures precisely and say when each figure applies (the date,",
      "tax year, or region it is valid for). If sources disagree or you",
      "cannot verify something, say so plainly instead of guessing.",
      "",
      `Question: ${query}`,
    ].join("\n"),
  });

  return {
    answer: result.text,
    sources: dedupeSources(
      result.sources as Array<{ url?: string; title?: string }>,
    ),
  };
}

export function getWebSearchTool() {
  return tool({
    description:
      "Search the web for current external information: prices, exchange " +
      "rates, tax rates and thresholds, deadlines, regulations, industry " +
      "benchmarks, news. Use for anything outside Midday's own data, and " +
      "for any figure that changes over time. Returns an answer with its " +
      "sources; cite them.",
    inputSchema: z.object({
      query: z
        .string()
        .min(3)
        .describe(
          "The question to research, in full. Include the country and year " +
            "when they matter (e.g. 'Belgian VAT rate on restaurant costs 2026').",
        ),
    }),
    execute: async ({ query }) => {
      try {
        return await runWebSearch(query);
      } catch (error) {
        // A failed search must not kill the turn, but the model has to know
        // the answer is unverified rather than silently fall back to memory.
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("[chat] web_search failed", { query, error: message });
        return {
          answer:
            "The web search failed, so this could not be verified. Tell the " +
            "user the figure could not be checked against a live source " +
            "instead of answering from memory.",
          sources: [],
        };
      }
    },
  });
}
