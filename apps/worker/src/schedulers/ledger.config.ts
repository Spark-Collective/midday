import type { StaticSchedulerConfig } from "../types/scheduler-config";

/**
 * Static scheduler for ledger auto-posting (spark, M6 layer 1): hourly, book
 * every transaction whose category maps to a GL account. Runs on the
 * accounting queue; judgment calls stay with the bookie.
 */
export const ledgerStaticSchedulers: StaticSchedulerConfig[] = [
  {
    // The KB is what stops the assistant inventing Belgian tax rules, so it
    // tracks GitHub rather than waiting for someone to remember. Hourly at
    // :20 costs one HTTP request when nothing changed.
    name: "accounting-kb-sync-scheduler",
    queue: "accounting",
    cron: "20 * * * *",
    jobName: "accounting-kb-sync",
    payload: {},
    options: {
      tz: "UTC",
    },
  },
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
  {
    name: "ledger-amortization-scheduler",
    queue: "accounting",
    cron: "0 2 1 * *", // 1st of the month 02:00 UTC, posts the previous month
    jobName: "ledger-amortization",
    payload: {},
    options: {
      tz: "UTC",
    },
  },
  {
    name: "cash-forecast-snapshot-scheduler",
    queue: "accounting",
    // 1st of the month 04:00 UTC, after the filings sweep so the curve includes
    // any obligation created overnight.
    cron: "0 4 1 * *",
    jobName: "cash-forecast-snapshot",
    payload: {},
    options: {
      tz: "UTC",
    },
  },
  {
    name: "proposals-expire-scheduler",
    queue: "accounting",
    // Nightly 03:15 UTC, just before the filings sweep. Idempotent, so a
    // missed night heals itself instead of needing a catch-up run.
    cron: "15 3 * * *",
    jobName: "proposals-expire",
    payload: {},
    options: {
      tz: "UTC",
    },
  },
  {
    name: "filings-generate-scheduler",
    queue: "accounting",
    cron: "30 3 * * *", // nightly 03:30 UTC; idempotent, so a missed run self-heals
    jobName: "filings-generate",
    payload: {},
    options: {
      tz: "UTC",
    },
  },
];
