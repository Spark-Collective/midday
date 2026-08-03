import { CashForecastSnapshotProcessor } from "./cash-forecast-snapshot";
import { FilingsGenerateProcessor } from "./filings-generate";
import { LedgerAmortizationProcessor } from "./ledger-amortization";
import { LedgerAutoPostProcessor } from "./ledger-auto-post";

export { CashForecastSnapshotProcessor } from "./cash-forecast-snapshot";
export { FilingsGenerateProcessor } from "./filings-generate";
export { LedgerAmortizationProcessor } from "./ledger-amortization";
export { LedgerAutoPostProcessor } from "./ledger-auto-post";

/**
 * Ledger processor registry (spark)
 * Maps job names to processor instances
 */
export const ledgerProcessors = {
  "cash-forecast-snapshot": new CashForecastSnapshotProcessor(),
  "filings-generate": new FilingsGenerateProcessor(),
  "ledger-amortization": new LedgerAmortizationProcessor(),
  "ledger-auto-post": new LedgerAutoPostProcessor(),
};
