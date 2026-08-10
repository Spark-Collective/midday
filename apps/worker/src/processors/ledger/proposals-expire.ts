import { primaryDb } from "@midday/db/client";
import { expireLapsedProposals } from "@midday/ledger";
import type { Job } from "bullmq";
import type { Pool } from "pg";
import { BaseProcessor } from "../base";

/**
 * Sweep offers past their validity date out of `sent` (spark, revenue engine).
 *
 * An offer that lapsed three months ago and still sits in the pipeline as
 * "sent" is how a win rate becomes a lie, and the number is only worth having
 * if nobody has to remember to tidy it. The sweep is idempotent — it only
 * touches rows already past `expires_at` — so a missed night heals itself on
 * the next run rather than needing a catch-up.
 *
 * Deliberately conservative about what it touches: `expireLapsedProposals`
 * moves only `sent` rows, so drafts, accepted work and anything a human
 * already decided are left alone.
 */
export class ProposalsExpireProcessor extends BaseProcessor<
  Record<string, never>
> {
  async process(_job: Job): Promise<unknown> {
    const pool = primaryDb.$client as Pool;

    const teams = await pool.query<{ team_id: string }>(
      `SELECT DISTINCT team_id FROM proposals WHERE status = 'sent'`,
    );

    let expired = 0;
    const failures: string[] = [];

    for (const { team_id: teamId } of teams.rows) {
      const client = await pool.connect();
      try {
        const r = await expireLapsedProposals(client, { teamId });
        expired += r.expired;
        if (r.expired > 0) {
          this.logger.info("proposals expired", {
            teamId,
            expired: r.expired,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "unknown error";
        this.logger.error("proposal expiry sweep failed", { teamId, message });
        failures.push(`${teamId}: ${message}`);
      } finally {
        client.release();
      }
    }

    this.logger.info("proposal expiry sweep complete", {
      teams: teams.rowCount ?? 0,
      expired,
      failed: failures.length,
    });

    // Surface a broken sweep as a failed job rather than a quiet success, so
    // the job-health check raises it (same contract as the ledger jobs).
    if (failures.length > 0) {
      throw new Error(`proposal expiry failed for: ${failures.join("; ")}`);
    }
    return { teams: teams.rowCount ?? 0, expired };
  }
}
