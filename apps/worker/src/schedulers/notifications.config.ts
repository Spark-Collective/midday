import type { StaticSchedulerConfig } from "../types/scheduler-config";

export const notificationsStaticSchedulers: StaticSchedulerConfig[] = [
  {
    name: "activity-notification-flush",
    queue: "notifications",
    cron: "*/1 * * * *",
    jobName: "activity-notification-flush",
    payload: {},
    options: {
      tz: "UTC",
    },
  },
  {
    name: "job-health-check-scheduler",
    queue: "notifications",
    cron: "5 * * * *", // hourly at :05, sweeps the previous hour
    jobName: "job-health-check",
    payload: {},
    options: {
      tz: "UTC",
    },
  },
];
