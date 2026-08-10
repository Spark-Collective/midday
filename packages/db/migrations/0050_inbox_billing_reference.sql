-- 0050_inbox_billing_reference.sql
-- The invoice a credit note credits, as carried by the transport (Peppol
-- BillingReference/InvoiceDocumentReference/ID). Stored at ingest so the
-- "book as purchase document" flow can pre-link credits_document_id without
-- re-parsing the UBL. NULL for documents that carry no reference.
ALTER TABLE "inbox" ADD COLUMN IF NOT EXISTS "billing_reference" text;

COMMENT ON COLUMN "inbox"."billing_reference" IS
  'Document number this credit note credits, from Peppol BillingReference. NULL when absent.';
