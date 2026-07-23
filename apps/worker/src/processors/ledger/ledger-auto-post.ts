import { primaryDb } from "@midday/db/client";
import { postInvoice, postTransaction } from "@midday/ledger";
import type { Job } from "bullmq";
import type { Pool } from "pg";
import { BaseProcessor } from "../base";

/**
 * Deterministic auto-posting (spark, M6 layer 1 of the three-layer split):
 * every hour, book all bank transactions whose category maps to a GL account
 * (plus transfers) AND all finalized invoices into the native ledger.
 * Judgment calls — unmapped categories — are deliberately left for the
 * bookie's Claude Code sessions. Idempotent: the partial unique index on
 * (source_type, source_id) and the invoice journal_entry_id pointer make a
 * double post impossible.
 *
 * Review hardening (2026-07-22):
 * - sources with a REVERSED entry are never auto-rebooked (an operator
 *   reversal is a hands-off signal; explicit rebooking goes through the
 *   glove);
 * - transactions before LEDGER_START_DATE (default 2026-01-01) are ignored —
 *   pre-ledger history lives in the imported 899 entries, whatever their
 *   Midday status says;
 * - months whose fiscal period is closed are skipped instead of failing
 *   hourly forever;
 * - a run with failing items THROWS at the end so the job-health-check
 *   alert fires (successes are already committed per item).
 */
const LEDGER_START = process.env.LEDGER_START_DATE ?? "2026-01-01";

export class LedgerAutoPostProcessor extends BaseProcessor<
  Record<string, never>
> {
  async process(_job: Job): Promise<unknown> {
    const pool = primaryDb.$client as Pool;

    const candidates = await pool.query(
      `SELECT t.id, t.team_id
         FROM transactions t
         JOIN transaction_categories tc
           ON tc.team_id = t.team_id AND tc.slug = t.category_slug
        WHERE t.status = 'posted' AND t.amount <> 0
          AND t.date >= $1::date
          AND (tc.gl_account_id IS NOT NULL OR t.category_slug = 'transfer')
          AND NOT EXISTS (SELECT 1 FROM journal_entries je
                           WHERE je.team_id = t.team_id
                             AND je.source_type = 'transaction'
                             AND je.source_id = t.id
                             AND je.status IN ('posted', 'reversed'))
          AND EXISTS (SELECT 1 FROM fiscal_periods fp
                       WHERE fp.team_id = t.team_id
                         AND fp.year = EXTRACT(YEAR FROM t.date)
                         AND fp.month = EXTRACT(MONTH FROM t.date)
                         AND fp.status = 'open')
        ORDER BY t.date, t.id
        LIMIT 500`,
      [LEDGER_START],
    );

    let posted = 0;
    let failed = 0;
    for (const row of candidates.rows) {
      const client = await pool.connect();
      try {
        await postTransaction(client, {
          transactionId: row.id,
          teamId: row.team_id,
        });
        posted++;
      } catch (error) {
        failed++;
        this.logger.warn("auto-post skipped transaction", {
          transactionId: row.id,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        client.release();
      }
    }

    // Finalized invoices that never reached the ledger (created since the
    // last run). Reversed invoices stay out until explicitly re-posted.
    const invoices = await pool.query(
      `SELECT i.id, i.invoice_number FROM invoices i
        WHERE i.status NOT IN ('draft', 'canceled', 'scheduled', 'refunded')
          AND i.journal_entry_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM journal_entries je
                           WHERE je.team_id = i.team_id
                             AND je.source_type = 'invoice'
                             AND je.source_id = i.id
                             AND je.status IN ('posted', 'reversed'))
        ORDER BY i.issue_date LIMIT 100`,
    );
    let invoicesPosted = 0;
    let invoicesFailed = 0;
    for (const inv of invoices.rows) {
      const client = await pool.connect();
      try {
        await postInvoice(client, { invoiceId: inv.id });
        invoicesPosted++;
      } catch (error) {
        invoicesFailed++;
        this.logger.warn("auto-post skipped invoice", {
          invoiceId: inv.id,
          invoiceNumber: inv.invoice_number,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        client.release();
      }
    }

    const summary = {
      candidates: candidates.rowCount,
      posted,
      failed,
      invoicesPosted,
      invoicesFailed,
    };
    this.logger.info("ledger auto-post run complete", summary);
    if (failed > 0 || invoicesFailed > 0) {
      // Surface through job-health-check: per-item failures otherwise die in
      // docker logs (successes above are already committed).
      throw new Error(
        `ledger-auto-post: ${failed} transactions + ${invoicesFailed} invoices failing`,
      );
    }
    return summary;
  }
}
