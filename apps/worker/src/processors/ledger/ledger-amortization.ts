import { primaryDb } from "@midday/db/client";
import { postAmortization } from "@midday/ledger";
import type { Job } from "bullmq";
import type { Pool } from "pg";
import { BaseProcessor } from "../base";

/**
 * Monthly amortization posting (spark, M6 layer 1). Review hardening
 * (2026-07-22): instead of "previous month only" (a missed run dropped that
 * month forever), sweep EVERY open fiscal period up to the previous month for
 * teams with active amortizations — the unique (item, period) key on
 * amortization_lines makes re-posting a no-op, so the sweep is idempotent
 * and self-healing. A failing period throws at the end so job-health-check
 * alerts instead of the gap dying in docker logs.
 */
export class LedgerAmortizationProcessor extends BaseProcessor<
  Record<string, never>
> {
  async process(_job: Job): Promise<unknown> {
    const pool = primaryDb.$client as Pool;
    const now = new Date();
    const prev = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
    );
    const cutoffYear = prev.getUTCFullYear();
    const cutoffMonth = prev.getUTCMonth() + 1;

    // Open periods up to the previous month, for teams with active items
    // registered before the period's end.
    const periods = await pool.query(
      `SELECT DISTINCT fp.team_id, fp.year, fp.month
         FROM fiscal_periods fp
         JOIN amortizations a ON a.team_id = fp.team_id AND a.status = 'active'
        WHERE fp.status = 'open'
          AND (fp.year < $1 OR (fp.year = $1 AND fp.month <= $2))
          AND make_date(fp.year, fp.month, 1) >= date_trunc('month', a.start_date)
        ORDER BY fp.year, fp.month`,
      [cutoffYear, cutoffMonth],
    );

    const results: Array<Record<string, unknown>> = [];
    let failures = 0;
    for (const p of periods.rows) {
      const client = await pool.connect();
      try {
        const res = await postAmortization(client, {
          teamId: p.team_id,
          year: p.year,
          month: p.month,
        });
        if (res.items > 0) {
          results.push({ period: `${p.year}-${p.month}`, ...res });
        }
      } catch (error) {
        failures++;
        this.logger.warn("amortization post failed", {
          teamId: p.team_id,
          year: p.year,
          month: p.month,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        client.release();
      }
    }

    this.logger.info("ledger amortization sweep complete", {
      periodsChecked: periods.rowCount,
      postedPeriods: results.length,
      failures,
    });
    if (failures > 0) {
      throw new Error(`ledger-amortization: ${failures} periods failing`);
    }
    return { periodsChecked: periods.rowCount, results };
  }
}
