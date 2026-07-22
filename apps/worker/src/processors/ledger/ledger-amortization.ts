import { primaryDb } from "@midday/db/client";
import { postAmortization } from "@midday/ledger";
import type { Job } from "bullmq";
import type { Pool } from "pg";
import { BaseProcessor } from "../base";

/**
 * Monthly amortization posting (spark, M6 layer 1): on the 1st, post the
 * PREVIOUS month's depreciation/deferral lines for every team with registered
 * amortizations. Idempotent via the unique (item, period) index on
 * amortization_lines; a team with nothing registered is a clean no-op.
 */
export class LedgerAmortizationProcessor extends BaseProcessor<
  Record<string, never>
> {
  async process(_job: Job): Promise<unknown> {
    const pool = primaryDb.$client as Pool;
    const now = new Date();
    // Previous month in UTC.
    const prev = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
    );
    const year = prev.getUTCFullYear();
    const month = prev.getUTCMonth() + 1;

    const teams = await pool.query(
      `SELECT DISTINCT team_id FROM amortizations WHERE status = 'active'`,
    );

    const results: Array<Record<string, unknown>> = [];
    for (const row of teams.rows) {
      const client = await pool.connect();
      try {
        const res = await postAmortization(client, {
          teamId: row.team_id,
          year,
          month,
        });
        results.push({ teamId: row.team_id, ...res });
      } catch (error) {
        this.logger.warn("amortization post failed", {
          teamId: row.team_id,
          year,
          month,
          error: error instanceof Error ? error.message : String(error),
        });
        results.push({ teamId: row.team_id, error: true });
      } finally {
        client.release();
      }
    }

    this.logger.info("ledger amortization run complete", {
      period: `${year}-${month}`,
      teams: teams.rowCount,
    });
    return { period: `${year}-${month}`, results };
  }
}
