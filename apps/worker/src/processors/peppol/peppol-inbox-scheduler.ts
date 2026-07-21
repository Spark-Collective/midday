import { createClient } from "@midday/supabase/job";
import type { Job } from "bullmq";
import { inboxQueue } from "../../queues/inbox";
import { getDocument, listDocuments } from "../../utils/recommand";
import { BaseProcessor } from "../base";

type PeppolInboxPayload = Record<string, never>;

/**
 * Scheduled Peppol inbox sync (spark): pull incoming documents from the
 * Recommand access point and feed them into Midday's inbox pipeline
 * (process-attachment -> OCR/classify -> transaction matching). Dedupe via
 * inbox.reference_id = "peppol_<documentId>". Single-tenant: everything lands
 * on the first (only) team.
 */
export class PeppolInboxSchedulerProcessor extends BaseProcessor<PeppolInboxPayload> {
  async process(_job: Job<PeppolInboxPayload>): Promise<{ imported: number; skipped: number }> {
    const supabase = createClient();

    const { data: teams } = await supabase.from("teams").select("id").limit(1).throwOnError();
    const teamId = teams?.[0]?.id;
    if (!teamId) {
      this.logger.warn("peppol-inbox: no team, skipping");
      return { imported: 0, skipped: 0 };
    }

    const docs = (await listDocuments(100)).filter((d) => d.direction === "incoming");

    let imported = 0;
    let skipped = 0;

    for (const doc of docs) {
      const referenceId = `peppol_${doc.id}`;

      const { data: existing } = await supabase
        .from("inbox")
        .select("id")
        .eq("reference_id", referenceId)
        .limit(1)
        .throwOnError();

      if (existing && existing.length > 0) {
        skipped++;
        continue;
      }

      try {
        const full = await getDocument(doc.id);
        const parsed = full.parsed ?? {};

        // Prefer an embedded PDF; fall back to the UBL XML itself.
        const pdf = (parsed.attachments ?? []).find(
          (a) =>
            (a.mimeCode ?? "").includes("pdf") && (a.embeddedDocument || a.content),
        );

        let buffer: Buffer;
        let filename: string;
        let mimetype: string;
        if (pdf) {
          buffer = Buffer.from((pdf.embeddedDocument || pdf.content)!, "base64");
          filename = pdf.filename || `${parsed.invoiceNumber || doc.id}.pdf`;
          mimetype = "application/pdf";
        } else if (full.xml) {
          buffer = Buffer.from(full.xml, "utf8");
          filename = `${parsed.invoiceNumber || doc.id}.xml`;
          mimetype = "application/xml";
        } else {
          this.logger.warn("peppol-inbox: document without attachment or xml", { id: doc.id });
          skipped++;
          continue;
        }

        // Keep vault filenames unique and path-safe.
        const safeName = filename.replace(/[^\w.-]+/g, "_");
        const filePath = [teamId, "inbox", `peppol_${doc.id}_${safeName}`];

        const { error: uploadError } = await supabase.storage
          .from("vault")
          .upload(filePath.join("/"), buffer, { contentType: mimetype, upsert: true });

        if (uploadError) {
          this.logger.error("peppol-inbox: upload failed", { id: doc.id, error: uploadError.message });
          continue;
        }

        await inboxQueue.add("process-attachment", {
          filePath,
          mimetype,
          size: buffer.length,
          senderEmail: undefined,
          teamId,
          referenceId,
        });

        imported++;
      } catch (error) {
        this.logger.error("peppol-inbox: document failed", {
          id: doc.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.logger.info("peppol-inbox completed", { imported, skipped });
    return { imported, skipped };
  }
}
