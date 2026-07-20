import { BankSyncSchedulerProcessor } from "./bank-sync-scheduler";

export { BankSyncSchedulerProcessor } from "./bank-sync-scheduler";

/**
 * Bank processor registry (spark)
 * Maps job names to processor instances
 */
export const bankProcessors = {
  "bank-sync-scheduler": new BankSyncSchedulerProcessor(),
};
