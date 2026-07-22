import { LedgerAmortizationProcessor } from "./ledger-amortization";
import { LedgerAutoPostProcessor } from "./ledger-auto-post";

export { LedgerAmortizationProcessor } from "./ledger-amortization";
export { LedgerAutoPostProcessor } from "./ledger-auto-post";

/**
 * Ledger processor registry (spark)
 * Maps job names to processor instances
 */
export const ledgerProcessors = {
  "ledger-amortization": new LedgerAmortizationProcessor(),
  "ledger-auto-post": new LedgerAutoPostProcessor(),
};
