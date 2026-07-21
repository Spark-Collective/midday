import { PeppolInboxSchedulerProcessor } from "./peppol-inbox-scheduler";
import { PeppolSendInvoiceProcessor } from "./peppol-send-invoice";

export { PeppolInboxSchedulerProcessor } from "./peppol-inbox-scheduler";
export { PeppolSendInvoiceProcessor } from "./peppol-send-invoice";

/**
 * Peppol processor registry (spark)
 */
export const peppolProcessors = {
  "peppol-inbox-scheduler": new PeppolInboxSchedulerProcessor(),
  "peppol-send-invoice": new PeppolSendInvoiceProcessor(),
};
