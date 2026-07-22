import { LedgerAutoPostProcessor } from "./ledger-auto-post";

export { LedgerAutoPostProcessor } from "./ledger-auto-post";

/**
 * Ledger processor registry (spark)
 * Maps job names to processor instances
 */
export const ledgerProcessors = {
  "ledger-auto-post": new LedgerAutoPostProcessor(),
};
