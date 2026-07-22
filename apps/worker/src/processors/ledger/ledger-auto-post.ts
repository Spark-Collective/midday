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
 */
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
          AND (tc.gl_account_id IS NOT NULL OR t.category_slug = 'transfer')
          AND NOT EXISTS (SELECT 1 FROM journal_entries je
                           WHERE je.team_id = t.team_id
                             AND je.source_type = 'transaction'
                             AND je.source_id = t.id AND je.status = 'posted')
        ORDER BY t.date, t.id
        LIMIT 500`,
    );

    let posted = 0;
    let failed = 0;
    for (const row of candidates.rows) {
      const client = await pool.connect();
      try {
        await postTransaction(client, { transactionId: row.id });
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

    // Finalized invoices that never reached the ledger (freed by a reversal
    // or created since the last run).
    const invoices = await pool.query(
      `SELECT id, invoice_number FROM invoices
        WHERE status NOT IN ('draft', 'canceled', 'scheduled')
          AND journal_entry_id IS NULL
        ORDER BY issue_date LIMIT 100`,
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

    this.logger.info("ledger auto-post run complete", {
      candidates: candidates.rowCount,
      posted,
      failed,
      invoicesPosted,
      invoicesFailed,
    });
    return {
      candidates: candidates.rowCount,
      posted,
      failed,
      invoicesPosted,
      invoicesFailed,
    };
  }
}
