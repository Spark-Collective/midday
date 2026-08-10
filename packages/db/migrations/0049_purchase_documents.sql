-- 0049_purchase_documents.sql
-- Purchase documents (M12): incoming supplier invoices and credit notes as
-- records, not just inbox rows waiting for a bank transaction. Design taken
-- from ERPNext (spec: midday-purchase-documents): a credit note is the SAME
-- record with a kind flag and a link to the invoice it credits, never its own
-- concept. Amounts are stored positive; `kind` carries the direction.
--
-- Posting (packages/ledger/src/post-purchase-document.ts):
--   invoice:      Dr cost lines (+ Dr deductible VAT)  /  Cr 440000
--   credit_note:  the exact mirror
-- Credit-side tax-coded lines land in VAT grids 85/63 for free; settlement of
-- invoice minus credit note against one bank payment is plain M2 allocation
-- on 440000. The trigger case: Combell 260807125 (+170,57) and creditnota
-- 260807528 (-113,72), settled by one net payment of 56,85.

-- The inbox can now say "credit note". Authoritative for Peppol (UBL document
-- root <CreditNote>, type code 381); PDFs routinely print positive amounts on
-- credit notes, so the sign alone is not trustworthy where it matters most.
ALTER TYPE "inbox_type" ADD VALUE IF NOT EXISTS 'credit_note';

CREATE TABLE "purchase_documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  -- Supplier identity as printed on the document. VAT number is the stable
  -- key when present (Peppol always carries it); name is the fallback.
  "supplier_name" text NOT NULL,
  "supplier_vat" text,
  "document_number" text NOT NULL,
  "kind" text NOT NULL,
  -- Which invoice this credit note credits. Nullable: a standalone credit
  -- note is legal (ERPNext's update_outstanding_for_self case).
  "credits_document_id" uuid REFERENCES "purchase_documents"("id") ON DELETE RESTRICT,
  "issue_date" date NOT NULL,
  "due_date" date,
  "currency" text DEFAULT 'EUR' NOT NULL,
  -- Total incl. VAT, always positive; `kind` carries the direction.
  "amount" numeric(12, 2) NOT NULL,
  "tax_amount" numeric(12, 2) DEFAULT 0 NOT NULL,
  -- Provenance: the inbox row this was created from, when there is one.
  "inbox_id" uuid REFERENCES "inbox"("id") ON DELETE SET NULL,
  "journal_entry_id" uuid REFERENCES "journal_entries"("id") ON DELETE SET NULL,
  -- draft -> posted -> settled. Only 'posted' and 'settled' carry an entry.
  "status" text DEFAULT 'draft' NOT NULL,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "purchase_documents_kind_check"
    CHECK ("kind" IN ('invoice', 'credit_note')),
  CONSTRAINT "purchase_documents_status_check"
    CHECK ("status" IN ('draft', 'posted', 'settled')),
  CONSTRAINT "purchase_documents_amount_positive" CHECK ("amount" > 0),
  CONSTRAINT "purchase_documents_tax_nonneg" CHECK ("tax_amount" >= 0),
  -- Only a credit note points at another document, and never at itself.
  CONSTRAINT "purchase_documents_credits_kind"
    CHECK ("credits_document_id" IS NULL OR "kind" = 'credit_note'),
  CONSTRAINT "purchase_documents_credits_not_self"
    CHECK ("credits_document_id" IS DISTINCT FROM "id"),
  -- One document per inbox row (numbers alone are not unique across
  -- suppliers: everyone issues a "2026-001").
  CONSTRAINT "purchase_documents_inbox_unique" UNIQUE ("team_id", "inbox_id")
);

CREATE INDEX "purchase_documents_team_idx"
  ON "purchase_documents" ("team_id", "issue_date" DESC);
CREATE INDEX "purchase_documents_supplier_idx"
  ON "purchase_documents" ("team_id", "supplier_name");
CREATE INDEX "purchase_documents_credits_idx"
  ON "purchase_documents" ("credits_document_id");

CREATE TABLE "purchase_document_lines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "purchase_document_id" uuid NOT NULL
    REFERENCES "purchase_documents"("id") ON DELETE CASCADE,
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "position" integer DEFAULT 0 NOT NULL,
  "description" text NOT NULL,
  -- Cost account as text (same choice as expense_note_lines): a document can
  -- be drafted before the chart is touched; posting resolves and fails loudly.
  "gl_account_code" text NOT NULL,
  -- Net amount, positive; the header's kind carries the direction.
  "amount" numeric(12, 2) NOT NULL,
  -- Tax code by symbol ("P21", "P06", ...) and this line's VAT amount.
  "tax_code" text,
  "tax_amount" numeric(12, 2) DEFAULT 0 NOT NULL,
  CONSTRAINT "purchase_document_lines_amount_positive" CHECK ("amount" > 0),
  CONSTRAINT "purchase_document_lines_tax_nonneg" CHECK ("tax_amount" >= 0)
);

CREATE INDEX "purchase_document_lines_doc_idx"
  ON "purchase_document_lines" ("purchase_document_id", "position");

-- Booked documents are frozen (same guard family as expense notes and
-- invoices): correct by reversing the entry, never by editing the record.
-- Status and the entry pointer stay writable (posted -> settled, reversal).
CREATE OR REPLACE FUNCTION purchase_document_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.journal_entry_id IS NOT NULL THEN
      RAISE EXCEPTION 'purchase document % is booked; reverse the entry first', OLD.document_number
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.journal_entry_id IS NOT NULL
     AND (NEW.amount IS DISTINCT FROM OLD.amount
       OR NEW.tax_amount IS DISTINCT FROM OLD.tax_amount
       OR NEW.issue_date IS DISTINCT FROM OLD.issue_date
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.supplier_name IS DISTINCT FROM OLD.supplier_name
       OR NEW.supplier_vat IS DISTINCT FROM OLD.supplier_vat
       OR NEW.document_number IS DISTINCT FROM OLD.document_number) THEN
    RAISE EXCEPTION 'purchase document % is booked; reverse the entry first', OLD.document_number
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER purchase_document_guard_trg
  BEFORE UPDATE OR DELETE ON purchase_documents
  FOR EACH ROW EXECUTE FUNCTION purchase_document_guard();

CREATE OR REPLACE FUNCTION purchase_document_line_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_entry uuid;
  v_number text;
BEGIN
  SELECT journal_entry_id, document_number INTO v_entry, v_number
    FROM purchase_documents
   WHERE id = COALESCE(NEW.purchase_document_id, OLD.purchase_document_id);
  IF v_entry IS NOT NULL THEN
    RAISE EXCEPTION 'purchase document % is booked; reverse the entry first', v_number
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER purchase_document_line_guard_trg
  BEFORE INSERT OR UPDATE OR DELETE ON purchase_document_lines
  FOR EACH ROW EXECUTE FUNCTION purchase_document_line_guard();
