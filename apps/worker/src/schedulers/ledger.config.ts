import type { StaticSchedulerConfig } from "../types/scheduler-config";

/**
 * Static scheduler for ledger auto-posting (spark, M6 layer 1): hourly, book
 * every transaction whose category maps to a GL account. Runs on the
 * accounting queue; judgment calls stay with the bookie.
 */
export const ledgerStaticSchedulers: StaticSchedulerConfig[] = [
  {
    name: "ledger-auto-post-scheduler",
    queue: "accounting",
    cron: "45 * * * *", // hourly at :45 (after the 4-hourly bank sync at :15)
    jobName: "ledger-auto-post",
    payload: {},
    options: {
      tz: "UTC",
    },
  },
];
