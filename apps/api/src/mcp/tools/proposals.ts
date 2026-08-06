/**
 * Proposal MCP tools — the authoring surface.
 *
 * Spark proposals are written by Claude Code, not typed into a form: a document
 * with scope, pricing and the SLA, plus the small commercial core the cash
 * forecast reads. So the write tool takes the whole document in one call and the
 * validation lives in @midday/ledger, where it is tested.
 *
 * `proposal_set_status` is the one that matters: `accepted` is the dated fact
 * that turns an offer into forecast revenue.
 */
import { primaryDb } from "@midday/db/client";
import {
  expireLapsedProposals,
  listProposals,
  setProposalStatus,
  upsertProposal,
} from "@midday/ledger";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  hasScope,
  READ_ONLY_ANNOTATIONS,
  type RegisterTools,
  WRITE_ANNOTATIONS,
} from "../types";
import { withErrorHandling } from "../utils";

const pool = () => primaryDb.$client as Pool;

async function withClient<T>(fn: (client: PoolClient) => Promise<T>) {
  const client = await pool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

const STATUSES = [
  "draft",
  "sent",
  "accepted",
  "declined",
  "expired",
  "withdrawn",
] as const;

export const registerProposalTools: RegisterTools = (server, ctx) => {
  const { teamId } = ctx;
  const canRead = hasScope(ctx, "proposals.read");
  const canWrite = hasScope(ctx, "proposals.write");
  if (!canRead && !canWrite) return;

  if (canRead) {
    server.registerTool(
      "proposals_list",
      {
        title: "List Proposals",
        description:
          "Proposals and quotes, with their status and how much has already been invoiced against each. Only 'accepted' proposals contribute to the cash forecast; everything earlier is pipeline.",
        inputSchema: {
          customerId: z.string().uuid().optional(),
          status: z.array(z.enum(STATUSES)).optional(),
          includeBody: z
            .boolean()
            .optional()
            .describe("Include the full markdown document and SLA"),
        },
        outputSchema: { data: z.array(z.record(z.string(), z.any())) },
        annotations: READ_ONLY_ANNOTATIONS,
      },
      withErrorHandling(async (params) => {
        const data = await withClient((c) =>
          listProposals(c, {
            teamId,
            customerId: params.customerId,
            status: params.status,
            includeBody: params.includeBody ?? false,
          }),
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data) }],
          structuredContent: { data },
        };
      }, "Failed to list proposals"),
    );
  }

  if (canWrite) {
    server.registerTool(
      "proposal_write",
      {
        title: "Write a Proposal",
        description:
          "Create or update a proposal: the markdown document (scope, pricing, SLA, next steps) plus the commercial core. Omit id to create. Only DRAFT proposals can be edited — once sent, withdraw and write a new one rather than changing terms the client has already read. A proposal needs a one-off amount, a recurring amount, or both.",
        inputSchema: {
          id: z.string().uuid().optional(),
          customerId: z.string().uuid().optional(),
          projectId: z
            .string()
            .uuid()
            .optional()
            .describe(
              "Link to a tracker project. Accepting the proposal clears that project's own expected figures so the money is forecast once.",
            ),
          title: z.string().min(1),
          currency: z.string().optional(),
          oneOffAmount: z.coerce.number().nonnegative().optional(),
          recurringAmount: z.coerce
            .number()
            .nonnegative()
            .optional()
            .describe("Retainer or SLA fee. Needs recurringInterval too."),
          recurringInterval: z.enum(["month", "quarter", "year"]).optional(),
          recurringMonths: z.coerce
            .number()
            .int()
            .positive()
            .optional()
            .describe("Committed term in months. Omit for until-cancelled."),
          validUntil: z.string().optional().describe("YYYY-MM-DD"),
          expectedInvoiceDate: z
            .string()
            .optional()
            .describe("YYYY-MM-DD, when the one-off will be billed"),
          bodyMd: z
            .string()
            .optional()
            .describe("The document in markdown, including the SLA section"),
          sla: z
            .record(z.string(), z.any())
            .optional()
            .describe(
              "Queryable SLA terms, e.g. { responseTime: '1 business day', noticePeriodDays: 30 }",
            ),
          documentUrl: z.string().optional(),
          vatRate: z.coerce
            .number()
            .min(0)
            .max(100)
            .optional()
            .describe(
              "VAT percent on the quoted amounts. Defaults to 21 (Belgian standard). Use 0 for intra-EU reverse charge and non-EU customers. Amounts are quoted NET; the forecast grosses them up because that is what actually lands in the bank.",
            ),
        },
        outputSchema: { data: z.record(z.string(), z.any()) },
        annotations: WRITE_ANNOTATIONS,
      },
      withErrorHandling(async (params) => {
        const data = await withClient((c) =>
          upsertProposal(c, { teamId, ...params }),
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data) }],
          structuredContent: { data },
        };
      }, "Failed to write the proposal"),
    );

    server.registerTool(
      "proposal_set_status",
      {
        title: "Move a Proposal Along",
        description:
          "draft -> sent -> accepted | declined | expired. Accepting an offer with a one-off amount requires expectedInvoiceDate: acceptance date is not invoice date. Accepting is what puts the money into the cash forecast, so only do it when the client has actually agreed.",
        inputSchema: {
          proposalId: z.string().uuid(),
          status: z.enum(STATUSES),
          expectedInvoiceDate: z
            .string()
            .optional()
            .describe("YYYY-MM-DD, required when accepting a one-off offer"),
        },
        outputSchema: { data: z.record(z.string(), z.any()) },
        annotations: WRITE_ANNOTATIONS,
      },
      withErrorHandling(async (params) => {
        const data = await withClient((c) =>
          setProposalStatus(c, { teamId, ...params }),
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data) }],
          structuredContent: { data },
        };
      }, "Failed to change the proposal status"),
    );

    server.registerTool(
      "proposals_expire_lapsed",
      {
        title: "Expire Lapsed Proposals",
        description:
          "Move sent proposals whose validity date has passed to 'expired'. Offers that lapsed months ago sitting in the pipeline as 'sent' are how a win rate becomes a lie.",
        inputSchema: {},
        outputSchema: { data: z.record(z.string(), z.any()) },
        annotations: WRITE_ANNOTATIONS,
      },
      withErrorHandling(async () => {
        const data = await withClient((c) =>
          expireLapsedProposals(c, { teamId }),
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data) }],
          structuredContent: { data },
        };
      }, "Failed to expire lapsed proposals"),
    );
  }
};
