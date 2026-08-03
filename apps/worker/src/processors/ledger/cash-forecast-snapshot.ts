import { primaryDb } from "@midday/db/client";
import { snapshotCashForecast } from "@midday/ledger";
import type { Job } from "bullmq";
import type { Pool } from "pg";
import { BaseProcessor } from "../base";

/**
 * Record what the forecast claimed, monthly (spark, C6).
 *
 * The point is not the snapshot, it is the scoring: the payment-lag model and
 * the trailing-average filing estimates only improve if their errors are
 * measurable, and you cannot measure an error against a curve you recomputed
 * from today's data. Snapshots are the only record of what was actually claimed.
 *
 * Idempotent per team per day, so a retry or a double schedule overwrites rather
 * than accumulates.
 */
export class CashForecastSnapshotProcessor extends BaseProcessor<
  Record<string, never>
> {
  async process(_job: Job): Promise<unknown> {
    const pool = primaryDb.$client as Pool;

    // A forecast needs a chart of accounts to know what tax is coming; teams
    // without one would snapshot a meaningless curve.
    const teams = await pool.query<{ team_id: string }>(
      `SELECT DISTINCT team_id FROM gl_accounts`,
    );

    const taken: string[] = [];
    const failures: string[] = [];

    for (const { team_id: teamId } of teams.rows) {
      const client = await pool.connect();
      try {
        await snapshotCashForecast(client, { teamId });
        taken.push(teamId);
      } catch (err) {
        failures.push(`${teamId}: ${(err as Error).message}`);
      } finally {
        client.release();
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `cash forecast snapshot failed for ${failures.length} team(s): ${failures.join("; ")}`,
      );
    }
    return { teams: teams.rowCount ?? 0, snapshotted: taken.length };
  }
}
