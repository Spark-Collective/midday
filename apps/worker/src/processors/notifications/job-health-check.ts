import { primaryDb } from "@midday/db/client";
import { triggerJob } from "@midday/job-client";
import type { Job } from "bullmq";
import type { Pool } from "pg";
import { getAllQueues } from "../../queues";
import { BaseProcessor } from "../base";

/**
 * Hourly job-failure sweep (spark): BullMQ failures otherwise die silently in
 * docker logs — exactly how the invite-email bug hid. Scans every queue for
 * jobs that failed inside the last window and emits ONE job_failed
 * notification (in-app) with a per-queue breakdown. Single-tenant self-host:
 * every team gets the alert.
 */
const WINDOW_MS = 65 * 60 * 1000; // hourly cron + 5 min overlap

export class JobHealthCheckProcessor extends BaseProcessor<
  Record<string, never>
> {
  async process(_job: Job): Promise<unknown> {
    const windowStart = Date.now() - WINDOW_MS;
    const byKey = new Map<
      string,
      { queue: string; jobName: string; count: number; lastError?: string }
    >();

    for (const queue of getAllQueues()) {
      const failed = await queue.getFailed(0, 200);
      for (const job of failed) {
        const finishedOn = job.finishedOn ?? 0;
        if (finishedOn < windowStart) continue;
        // The sweep's own notification jobs failing would loop the alert.
        if (job.name === "job-health-check") continue;
        const key = `${queue.name}:${job.name}`;
        const entry = byKey.get(key) ?? {
          queue: queue.name,
          jobName: job.name,
          count: 0,
        };
        entry.count++;
        entry.lastError = job.failedReason?.slice(0, 300) ?? entry.lastError;
        byKey.set(key, entry);
      }
    }

    const breakdown = [...byKey.values()].sort((a, b) => b.count - a.count);
    const failedCount = breakdown.reduce((s, b) => s + b.count, 0);

    if (failedCount === 0) {
      this.logger.info("job health check: all clear");
      return { failedCount: 0 };
    }

    const pool = primaryDb.$client as Pool;
    const teams = await pool.query(`SELECT id FROM teams`);
    for (const team of teams.rows) {
      await triggerJob(
        "notification",
        {
          type: "job_failed",
          teamId: team.id,
          failedCount,
          windowStart: new Date(windowStart).toISOString(),
          windowEnd: new Date().toISOString(),
          breakdown,
        },
        "notifications",
      );
    }

    this.logger.warn("job health check: failures detected", {
      failedCount,
      breakdown,
    });
    return { failedCount, breakdown };
  }
}
