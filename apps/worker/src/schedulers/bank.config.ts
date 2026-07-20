import type { StaticSchedulerConfig } from "../types/scheduler-config";

/**
 * Static scheduler for bank syncs (spark): every 4 hours, refresh balances and
 * pull the latest transactions for all connected accounts via the provider
 * registry (Ponto). Runs on the transactions queue.
 */
export const bankStaticSchedulers: StaticSchedulerConfig[] = [
  {
    name: "bank-sync-scheduler",
    queue: "transactions",
    cron: "15 */4 * * *", // every 4 hours at :15
    jobName: "bank-sync-scheduler",
    payload: {},
    options: {
      tz: "UTC",
    },
  },
];
