import { primaryDb } from "@midday/db/client";
import { generateFilings } from "@midday/ledger";
import type { Job } from "bullmq";
import type { Pool } from "pg";
import { BaseProcessor } from "../base";

/**
 * Keep the filing calendar populated (spark, C1).
 *
 * Generation is idempotent — the partial unique indexes on `filings` make a
 * re-run a no-op — so this sweeps the CURRENT and NEXT year every night rather
 * than trying to fire exactly once at the year boundary. A missed run therefore
 * heals itself instead of leaving a company with no visible obligations, which
 * is the failure that actually costs money.
 *
 * Every team with a chart of accounts gets a calendar; personal-tax filings are
 * created per active director.
 */
export class FilingsGenerateProcessor extends BaseProcessor<
  Record<string, never>
> {
  async process(_job: Job): Promise<unknown> {
    const pool = primaryDb.$client as Pool;
    const year = new Date().getUTCFullYear();

    const teams = await pool.query<{ team_id: string }>(
      `SELECT DISTINCT team_id FROM gl_accounts`,
    );

    const results: Array<{ teamId: string; year: number; created: number }> =
      [];
    const failures: string[] = [];

    for (const { team_id: teamId } of teams.rows) {
      const client = await pool.connect();
      try {
        const directors = await client.query<{ id: string }>(
          `SELECT id FROM directors WHERE team_id = $1 AND active`,
          [teamId],
        );
        const directorIds = directors.rows.map((d) => d.id);
        for (const y of [year, year + 1]) {
          const res = await generateFilings(client, {
            teamId,
            year: y,
            directorIds,
          });
          if (res.created > 0) {
            results.push({ teamId, year: y, created: res.created });
          }
        }
      } catch (err) {
        failures.push(`${teamId}: ${(err as Error).message}`);
      } finally {
        client.release();
      }
    }

    // Surface failures to job-health-check rather than letting a team sit
    // without a calendar and nobody noticing.
    if (failures.length > 0) {
      throw new Error(
        `filings generation failed for ${failures.length} team(s): ${failures.join("; ")}`,
      );
    }
    return { teams: teams.rowCount ?? 0, generated: results };
  }
}
