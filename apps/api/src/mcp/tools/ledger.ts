/**
 * Ledger MCP tools — the bookie's glove (§11c three-layer split): a Claude
 * Code session reasons over the books through these, scoped by the
 * ledger.read / ledger.write API-key scopes. Writes go through the tested
 * @midday/ledger primitives on a dedicated pg connection; the DB invariants
 * (I1-I8) remain the backstop.
 */
import { primaryDb } from "@midday/db/client";
import {
  computeVatGrids,
  getGeneralLedger,
  getOpenItems,
  getTrialBalance,
  postEntry,
  postTransaction,
  reconcile,
  reverseEntry,
} from "@midday/ledger";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  DESTRUCTIVE_ANNOTATIONS,
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

const lineSchema = z.object({
  accountCode: z.string().optional().describe("PCMN account code, e.g. 611010"),
  systemKey: z
    .string()
    .optional()
    .describe("System account key (e.g. vat_deductible) instead of a code"),
  debit: z.coerce.number().optional(),
  credit: z.coerce.number().optional(),
  description: z.string().optional(),
  taxCode: z
    .string()
    .optional()
    .describe("Tax code (e.g. P21, P21-ICS) — feeds the VAT-return grids"),
  taxBase: z.coerce
    .number()
    .optional()
    .describe("VAT base amount for this tax line"),
});

/** Resolve lineSchema taxCode strings to tax_codes ids for postEntry. */
async function resolveTaxCodes(
  client: PoolClient,
  teamId: string,
  lines: Array<z.infer<typeof lineSchema>>,
) {
  const codes = [...new Set(lines.flatMap((l) => (l.taxCode ? [l.taxCode] : [])))];
  if (codes.length === 0) return new Map<string, string>();
  const res = await client.query(
    `SELECT code, id FROM tax_codes WHERE team_id = $1 AND code = ANY($2)`,
    [teamId, codes],
  );
  const map = new Map<string, string>(res.rows.map((r) => [r.code, r.id]));
  const missing = codes.filter((c) => !map.has(c));
  if (missing.length > 0) {
    throw new Error(`Unknown tax code(s): ${missing.join(", ")}`);
  }
  return map;
}

export const registerLedgerTools: RegisterTools = (server, ctx) => {
  const { teamId } = ctx;

  const canRead = hasScope(ctx, "ledger.read");
  const canWrite = hasScope(ctx, "ledger.write");

  if (!canRead && !canWrite) {
    return;
  }

  if (canRead) {
    server.registerTool(
      "ledger_unbooked_transactions",
      {
        title: "List Unbooked Transactions",
        description:
          "Bank transactions with no posted journal entry — the booking queue. Each row carries the category and, when the category is mapped, the PCMN account it would book to; rows without a mapped account need a judgment call (ledger_book_transaction with an override).",
        inputSchema: {
          limit: z.coerce.number().min(1).max(500).optional(),
        },
        outputSchema: { data: z.array(z.record(z.string(), z.any())) },
        annotations: READ_ONLY_ANNOTATIONS,
      },
      withErrorHandling(async (params) => {
        const r = await pool().query(
          `SELECT t.id, t.date::text AS date, t.name, t.amount, t.currency,
                  t.category_slug, a.code AS mapped_account_code,
                  t.tax_amount, b.name AS bank_account
             FROM transactions t
             LEFT JOIN transaction_categories tc
               ON tc.team_id = t.team_id AND tc.slug = t.category_slug
             LEFT JOIN gl_accounts a ON a.id = tc.gl_account_id
             LEFT JOIN bank_accounts b ON b.id = t.bank_account_id
            WHERE t.team_id = $1 AND t.status = 'posted' AND t.amount <> 0
              AND NOT EXISTS (SELECT 1 FROM journal_entries je
                               WHERE je.team_id = t.team_id
                                 AND je.source_type = 'transaction'
                                 AND je.source_id = t.id AND je.status = 'posted')
            ORDER BY t.date, t.id LIMIT $2`,
          [teamId, params.limit ?? 100],
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(r.rows) }],
          structuredContent: { data: r.rows },
        };
      }, "Failed to list unbooked transactions"),
    );

    server.registerTool(
      "ledger_chart_of_accounts",
      {
        title: "Chart of Accounts",
        description:
          "All GL accounts with code, name, type, system key, VAT deductibility percentage and verworpen-uitgaven category. Use these codes in ledger_book_transaction and ledger_post_entry.",
        inputSchema: {},
        outputSchema: { data: z.array(z.record(z.string(), z.any())) },
        annotations: READ_ONLY_ANNOTATIONS,
      },
      withErrorHandling(async () => {
        const r = await pool().query(
          `SELECT code, name, type, system_key, vat_deductible_pct, vu_category
             FROM gl_accounts WHERE team_id = $1 ORDER BY code`,
          [teamId],
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(r.rows) }],
          structuredContent: { data: r.rows },
        };
      }, "Failed to list chart of accounts"),
    );

    server.registerTool(
      "ledger_trial_balance",
      {
        title: "Trial Balance",
        description:
          "Trial balance over posted entries, optionally date-bounded (from/to, YYYY-MM-DD). Balance-sheet positions need no from-bound; P&L views should be bounded to the fiscal year.",
        inputSchema: {
          from: z.string().optional(),
          to: z.string().optional(),
        },
        outputSchema: { data: z.array(z.record(z.string(), z.any())) },
        annotations: READ_ONLY_ANNOTATIONS,
      },
      withErrorHandling(async (params) => {
        const data = await getTrialBalance(pool(), {
          teamId,
          from: params.from,
          to: params.to,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data) }],
          structuredContent: { data },
        };
      }, "Failed to compute trial balance"),
    );

    server.registerTool(
      "ledger_general_ledger",
      {
        title: "General Ledger",
        description:
          "Posted ledger lines, filterable by account code and date range. Returns entry numbers for drill-down and audit.",
        inputSchema: {
          accountCode: z.string().optional(),
          from: z.string().optional(),
          to: z.string().optional(),
          limit: z.coerce.number().min(1).max(500).optional(),
        },
        outputSchema: { data: z.array(z.record(z.string(), z.any())) },
        annotations: READ_ONLY_ANNOTATIONS,
      },
      withErrorHandling(async (params) => {
        const data = await getGeneralLedger(pool(), {
          teamId,
          accountCode: params.accountCode,
          from: params.from,
          to: params.to,
          limit: params.limit ?? 100,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data) }],
          structuredContent: { data },
        };
      }, "Failed to read general ledger"),
    );

    server.registerTool(
      "ledger_open_items",
      {
        title: "Open Items",
        description:
          "Unreconciled AR/AP/advance lines with their residual amounts — what customers still owe and what we still owe suppliers. Feed the line ids into ledger_reconcile when a payment settles them.",
        inputSchema: {
          partyType: z.enum(["customer", "supplier"]).optional(),
        },
        outputSchema: { data: z.array(z.record(z.string(), z.any())) },
        annotations: READ_ONLY_ANNOTATIONS,
      },
      withErrorHandling(async (params) => {
        const data = await getOpenItems(pool(), {
          teamId,
          partyType: params.partyType,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data) }],
          structuredContent: { data },
        };
      }, "Failed to list open items"),
    );

    server.registerTool(
      "ledger_vat_return",
      {
        title: "VAT Return Grids",
        description:
          "Belgian VAT return grids for a quarter, computed from posted entries, with warnings (incl. verify-live reminders). Submission itself goes through Intervat, never from here.",
        inputSchema: {
          year: z.coerce.number().min(2023).max(2100),
          quarter: z.coerce.number().min(1).max(4),
        },
        outputSchema: {
          grids: z.record(z.string(), z.any()),
          warnings: z.array(z.string()),
        },
        annotations: READ_ONLY_ANNOTATIONS,
      },
      withErrorHandling(async (params) => {
        const result = await computeVatGrids(pool(), {
          teamId,
          period: { year: params.year, quarter: params.quarter },
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: result as Record<string, unknown>,
        };
      }, "Failed to compute VAT return"),
    );
  }

  if (canWrite) {
    server.registerTool(
      "ledger_book_transaction",
      {
        title: "Book Bank Transaction",
        description:
          "Post a bank transaction into its bank journal. Without an override it books via the category's mapped account (deterministic path). With an override it books to the given PCMN account, optionally splitting out VAT the bank feed lacks — the judgment path. Idempotent per transaction.",
        inputSchema: {
          transactionId: z.string().uuid(),
          overrideAccountCode: z
            .string()
            .optional()
            .describe("Book to this account instead of the category mapping"),
          vatAmount: z.coerce
            .number()
            .optional()
            .describe("VAT amount in the transaction currency"),
          vatDeductiblePct: z.coerce.number().min(0).max(100).optional(),
        },
        outputSchema: {
          entryId: z.string(),
          entryNumber: z.string(),
        },
        annotations: WRITE_ANNOTATIONS,
      },
      withErrorHandling(async (params) => {
        const result = await withClient((client) =>
          postTransaction(client, {
            transactionId: params.transactionId,
            teamId,
            override: params.overrideAccountCode
              ? {
                  accountCode: params.overrideAccountCode,
                  vatAmount: params.vatAmount,
                  vatDeductiblePct: params.vatDeductiblePct,
                }
              : undefined,
          }),
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: result,
        };
      }, "Failed to book transaction"),
    );

    server.registerTool(
      "ledger_post_entry",
      {
        title: "Post Manual Journal Entry",
        description:
          "Post a balanced manual journal entry (miscellaneous bookings: accruals, corrections via new entries, VAT settlement). Lines must balance to the cent; the period must be open. For fixing a wrong posted entry use ledger_reverse, never a delta entry.",
        inputSchema: {
          journalCode: z
            .string()
            .describe("Journal code, e.g. 800 (Diversen) or 890"),
          date: z.string().describe("YYYY-MM-DD"),
          narration: z.string().optional(),
          lines: z.array(lineSchema).min(2),
        },
        outputSchema: {
          entryId: z.string(),
          entryNumber: z.string(),
        },
        annotations: WRITE_ANNOTATIONS,
      },
      withErrorHandling(async (params) => {
        const result = await withClient(async (client) => {
          const taxIds = await resolveTaxCodes(client, teamId, params.lines);
          return postEntry(client, {
            teamId,
            journalCode: params.journalCode,
            date: params.date,
            narration: params.narration,
            sourceType: "manual",
            lines: params.lines.map(({ taxCode, ...l }) => ({
              ...l,
              taxCodeId: taxCode ? taxIds.get(taxCode) : undefined,
            })),
          });
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: result,
        };
      }, "Failed to post entry"),
    );

    server.registerTool(
      "ledger_reconcile",
      {
        title: "Reconcile Ledger Lines",
        description:
          "Pairwise-reconcile open-item lines (invoice vs payment on the same account). Unbalanced sets stay partially open with a residual; small residuals can settle as FX or write-off entries per the ledger's tolerance rules.",
        inputSchema: {
          lineIds: z.array(z.string().uuid()).min(2),
        },
        outputSchema: {
          status: z.string(),
          allocated: z.number(),
          residual: z.number(),
        },
        annotations: WRITE_ANNOTATIONS,
      },
      withErrorHandling(async (params) => {
        const result = await withClient((client) =>
          reconcile(client, { teamId, lineIds: params.lineIds }),
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }, "Failed to reconcile"),
    );

    server.registerTool(
      "ledger_reverse",
      {
        title: "Reverse Journal Entry",
        description:
          "Reverse a posted entry with a mirror entry — the only correction path (posted entries are immutable). Frees the source document to re-post corrected.",
        inputSchema: {
          entryId: z.string().uuid(),
          date: z
            .string()
            .optional()
            .describe("Reversal date, defaults to the original's"),
          narration: z.string().optional(),
        },
        outputSchema: {
          entryId: z.string(),
          entryNumber: z.string(),
        },
        annotations: DESTRUCTIVE_ANNOTATIONS,
      },
      withErrorHandling(async (params) => {
        const result = await withClient((client) =>
          reverseEntry(client, {
            teamId,
            entryId: params.entryId,
            date: params.date,
            narration: params.narration,
          }),
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: result,
        };
      }, "Failed to reverse entry"),
    );
  }
};
