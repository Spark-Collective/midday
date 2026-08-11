/**
 * Belgian accounting knowledge, as a tool.
 *
 * Without this the assistant answers Belgian tax and bookkeeping questions
 * from Gemini's pretrained memory: no source, no account code, no sense of
 * which figures go stale. This exposes the accounting-knowledge-graph, which
 * carries the practice AND its own judgment about how far each page can be
 * trusted.
 *
 * The KB's rule is enforced in the result, not left to the model's goodwill:
 * a page marked verify_live, rated medium/low confidence, or past its review
 * date comes back with `mustVerify` and its sources, so the live number must
 * be fetched with web_search before it reaches a booking or a filing.
 *
 * Registered here rather than in the chat agent so the dashboard assistant,
 * the bookie's glove, and any external MCP client all get it from one place.
 */
import { primaryDb } from "@midday/db/client";
import { searchAccountingKb } from "@midday/documents/kb";
import type { Pool } from "pg";
import { z } from "zod";
import { type RegisterTools, READ_ONLY_ANNOTATIONS } from "../types";
import { withErrorHandling } from "../utils";

export const registerAccountingKbTools: RegisterTools = (server) => {
  server.registerTool(
    "accounting_kb_search",
    {
      title: "Search Belgian Accounting Knowledge",
      description:
        "Belgian accounting, VAT, deductibility, payroll and year-end " +
        "practice for a one-person BV: which account to book to, what is " +
        "deductible and by how much, how a VAT return box is filled, what " +
        "a workflow requires. ALWAYS consult this before answering a " +
        "Belgian accounting question; never answer such questions from " +
        "memory. Returns passages with their sources and a flag when a " +
        "figure must be re-verified live.",
      inputSchema: {
        query: z
          .string()
          .min(3)
          .describe(
            "What you need to know, in natural language. Dutch terms work " +
              "as well as English ('restaurantkosten aftrekbaar', 'vak 59').",
          ),
        limit: z.coerce.number().min(1).max(15).optional(),
      },
      outputSchema: {
        results: z.array(z.record(z.string(), z.any())),
        mustVerify: z.boolean(),
        guidance: z.string().nullable(),
        kbVersion: z.string().nullable(),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    withErrorHandling(async (params) => {
      const result = await searchAccountingKb(primaryDb.$client as Pool, {
        query: params.query,
        limit: params.limit,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result,
      };
    }, "Failed to search the accounting knowledge base"),
  );
};
