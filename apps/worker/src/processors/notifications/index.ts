import { ActivityNotificationFlushProcessor } from "./activity-notification-flush";
import { JobHealthCheckProcessor } from "./job-health-check";
import { NotificationProcessor } from "./notification";

/**
 * Export all notification processors (for type imports)
 */
export { ActivityNotificationFlushProcessor } from "./activity-notification-flush";
export { NotificationProcessor } from "./notification";

/**
 * Notification processor registry
 * Maps job names to processor instances
 */
export const notificationProcessors = {
  "activity-notification-flush": new ActivityNotificationFlushProcessor(),
  "job-health-check": new JobHealthCheckProcessor(),
  notification: new NotificationProcessor(),
};
