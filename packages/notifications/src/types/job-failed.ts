import type { NotificationHandler } from "../base";
import { jobFailedSchema } from "../schemas";

/**
 * Background-job failure alert (spark): BullMQ failures otherwise die
 * silently in docker logs. In-app only; the hourly job-health-check sweep
 * emits at most one of these per window.
 */
export const jobFailed: NotificationHandler = {
  schema: jobFailedSchema,

  createActivity: (data, user) => ({
    teamId: user.team_id,
    userId: user.id,
    type: "job_failed",
    source: "system",
    priority: 2,
    metadata: {
      failedCount: data.failedCount,
      windowStart: data.windowStart,
      windowEnd: data.windowEnd,
      breakdown: data.breakdown,
    },
  }),
};
