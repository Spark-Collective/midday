import type { StaticSchedulerConfig } from "../types/scheduler-config";

/**
 * Static scheduler for the Peppol inbox (spark): hourly pull of incoming
 * documents from the Recommand access point into Midday's inbox pipeline.
 */
export const peppolStaticSchedulers: StaticSchedulerConfig[] = [
  {
    name: "peppol-inbox-scheduler",
    queue: "inbox",
    cron: "40 * * * *", // hourly at :40
    jobName: "peppol-inbox-scheduler",
    payload: {},
    options: {
      tz: "UTC",
    },
  },
];
