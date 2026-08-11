import { formatISO } from "date-fns";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../client";
import { transactions } from "../schema";
import { getCashBalance } from "./bank-accounts";
import { getInboxByStatus } from "./inbox-matching";
import { getInvoiceSummary } from "./invoices";
import { getRunway } from "./reports";
import { getBillableHours } from "./tracker-entries";

/**
 * The native-ledger replacement for the export-to-accountant counter. Upstream
 * Midday counted receipt-matched transactions never exported to an external
 * accountant, a ratchet once the ledger IS the accountant. What the books
 * actually still need, over the ledger era only:
 *   toBook           posted transactions with no journal entry yet
 *   missingDocument  transactions with neither an attachment nor a matched
 *                    inbox item (transfers carry no documents, skipped)
 */
/**
 * One statement with an explicit alias, deliberately NOT a drizzle
 * `select({...})` projection: interpolating `${transactions.id}` into a
 * projection renders it unqualified as `"id"`, which a correlated subquery
 * silently resolves to the INNER table's id. That yields a never-true
 * condition and a plausible wrong count rather than an error (it shipped
 * 297/297 once). Exported so a test can assert the correlation survives.
 */
export function ledgerReviewStatsQuery(teamId: string, since: string) {
  return sql`
    SELECT
      COUNT(*) FILTER (WHERE NOT EXISTS (
        SELECT 1 FROM journal_entries je
         WHERE je.source_id = t.id
           AND je.status IN ('posted', 'reversed')))::int AS to_book,
      COUNT(*) FILTER (WHERE
        t.category_slug IS DISTINCT FROM 'transfer'
        AND NOT EXISTS (
          SELECT 1 FROM transaction_attachments ta
           WHERE ta.transaction_id = t.id)
        AND NOT EXISTS (
          SELECT 1 FROM inbox i
           WHERE i.transaction_id = t.id AND i.status <> 'deleted'))::int
        AS missing_document
    FROM transactions t
   WHERE t.team_id = ${teamId}
     AND t.status = 'posted'
     AND t.date >= ${since}`;
}

async function getLedgerReviewStats(
  db: Database,
  teamId: string,
): Promise<{ toBook: number; missingDocument: number }> {
  const start = process.env.LEDGER_START_DATE || "2026-01-01";
  const result = await db.execute(ledgerReviewStatsQuery(teamId, start));
  const row = (result.rows ?? result)[0] as
    | { to_book: number; missing_document: number }
    | undefined;
  return {
    toBook: Number(row?.to_book ?? 0),
    missingDocument: Number(row?.missing_document ?? 0),
  };
}

export type OverviewSummary = {
  openInvoices: {
    count: number;
    totalAmount: number;
    currency: string;
  };
  unbilledTime: {
    totalDuration: number;
    totalAmount: number;
    projectCount: number;
    currency: string;
  };
  inboxPending: {
    count: number;
  };
  transactionsToReview: {
    count: number;
  };
  missingDocuments: {
    count: number;
  };
  cashBalance: {
    totalBalance: number;
    currency: string;
    accountCount: number;
  };
  runway: number;
};

export type GetOverviewSummaryParams = {
  teamId: string;
  currency?: string;
};

export async function getOverviewSummary(
  db: Database,
  params: GetOverviewSummaryParams,
): Promise<OverviewSummary> {
  const { teamId, currency } = params;
  const today = formatISO(new Date(), { representation: "date" });

  const [openInv, billable, pendingInbox, ledgerStats, cash, runwayResult] =
    await Promise.all([
      getInvoiceSummary(db, {
        teamId,
        statuses: ["draft", "scheduled", "unpaid"],
      }),
      getBillableHours(db, { teamId, date: today, view: "month" }),
      getInboxByStatus(db, { teamId, status: "pending" }),
      getLedgerReviewStats(db, teamId),
      getCashBalance(db, { teamId, currency }),
      getRunway(db, { teamId, currency }),
    ]);

  return {
    openInvoices: {
      count: openInv.invoiceCount,
      totalAmount: openInv.totalAmount,
      currency: openInv.currency,
    },
    unbilledTime: {
      totalDuration: billable.totalDuration,
      totalAmount: billable.totalAmount,
      projectCount: billable.projectBreakdown.length,
      currency: billable.currency,
    },
    inboxPending: {
      count: pendingInbox.length,
    },
    transactionsToReview: {
      count: ledgerStats.toBook,
    },
    missingDocuments: {
      count: ledgerStats.missingDocument,
    },
    cashBalance: {
      totalBalance: cash.totalBalance,
      currency: cash.currency,
      accountCount: cash.accountCount,
    },
    runway: runwayResult.months,
  };
}
