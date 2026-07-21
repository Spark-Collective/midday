import { createClient } from "@midday/supabase/job";
import type { Job } from "bullmq";
import { sendDocument } from "../../utils/recommand";
import { BaseProcessor } from "../base";

type PeppolSendPayload = {
  invoiceId: string;
};

type LineItem = { name?: string; quantity?: number; price?: number; vat?: number };

/**
 * Send a finalized Midday invoice over Peppol via Recommand (spark).
 * Enqueued from the invoice send flow (operator's "Create & Send" click is the
 * approval). Skips silently when the customer has no Belgian enterprise number
 * (Peppol recipient = 0208:<KBO>). Recommand builds the UBL from structured
 * JSON. Result is recorded on the invoice's internal_note.
 * ponytail: note-based record; add a peppol_message_id column if we ever need
 * to query on it.
 */
export class PeppolSendInvoiceProcessor extends BaseProcessor<PeppolSendPayload> {
  async process(job: Job<PeppolSendPayload>): Promise<{ sent: boolean; reason?: string }> {
    const { invoiceId } = job.data;
    const supabase = createClient();

    const { data: invoices } = await supabase
      .from("invoices")
      .select("id, invoice_number, issue_date, due_date, currency, line_items, internal_note, customer_id, team_id")
      .eq("id", invoiceId)
      .limit(1)
      .throwOnError();

    const invoice = invoices?.[0];
    if (!invoice) return { sent: false, reason: "invoice not found" };
    if (!invoice.customer_id) return { sent: false, reason: "invoice has no customer" };

    if ((invoice.internal_note ?? "").includes("Peppol sent")) {
      return { sent: false, reason: "already sent via Peppol" };
    }

    const { data: customers } = await supabase
      .from("customers")
      .select("name, vat_number, address_line_1, city, zip, country_code")
      .eq("id", invoice.customer_id)
      .limit(1)
      .throwOnError();

    const customer = customers?.[0];
    const vat = (customer?.vat_number ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!customer || !vat.startsWith("BE")) {
      this.logger.info("peppol-send: no Belgian VAT number, skipping", { invoiceId });
      return { sent: false, reason: "customer has no BE enterprise number" };
    }
    const kbo = vat.slice(2);

    const lines = ((invoice.line_items ?? []) as LineItem[]).map((l) => ({
      description: l.name || "Services",
      quantity: l.quantity ?? 1,
      netPriceAmount: l.price ?? 0,
      vat: { percentage: l.vat ?? 21 },
    }));

    const result = await sendDocument({
      recipient: `0208:${kbo}`,
      documentType: "invoice",
      document: {
        invoiceNumber: invoice.invoice_number,
        issueDate: (invoice.issue_date ?? "").slice(0, 10),
        dueDate: (invoice.due_date ?? "").slice(0, 10),
        currency: invoice.currency ?? "EUR",
        buyer: {
          name: customer.name,
          street: customer.address_line_1 ?? undefined,
          city: customer.city ?? undefined,
          postalZone: customer.zip ?? undefined,
          country: customer.country_code ?? "BE",
          vatNumber: customer.vat_number,
        },
        lines,
      },
    });

    const docId =
      (result as { documentId?: string; id?: string }).documentId ??
      (result as { documentId?: string; id?: string }).id ??
      "unknown";

    const note = `${invoice.internal_note ? `${invoice.internal_note}\n` : ""}Peppol sent ${docId} at ${new Date().toISOString()} (recipient 0208:${kbo})`;
    await supabase.from("invoices").update({ internal_note: note }).eq("id", invoiceId);

    this.logger.info("peppol-send: sent", { invoiceId, docId, recipient: `0208:${kbo}` });
    return { sent: true };
  }
}
