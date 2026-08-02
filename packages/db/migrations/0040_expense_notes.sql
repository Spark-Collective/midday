-- 0040_expense_notes.sql
-- Onkostennota's (M10): the document a director files to claim personally-paid
-- business costs back from the company. The mirror of an invoice: no customer,
-- no VAT (the underlying supplier invoice is in the director's own name, so the
-- company deducts no input VAT), and the counterparty is a director's R/C
-- account (directors.gl_account_id), never a bank line directly.
--
-- Posting (packages/ledger/src/post-expense-note.ts):
--   Dr <line.gl_account_code> per line   /   Cr director R/C (total)
-- The later payout to the director's private IBAN reconciles against that R/C
-- line, so "what the company owes me" is live instead of a year-end surprise.
--
-- Two tables, deliberately thin: the header carries identity + status, the
-- lines carry the calculation. A line is either a flat amount, or
-- quantity x unit_price (kWh x tariff for EV home charging, the only method
-- besides actual cost that holds up: see accounting-kb
-- concepts/deductible-costs/ev-charging-reimbursement.md, verify_live).

CREATE TABLE "expense_notes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  -- Who is claiming. director_id is the accounting truth (its R/C is credited);
  -- the submitter_* fields are the document's letterhead at issue time.
  "director_id" uuid REFERENCES "directors"("id") ON DELETE RESTRICT,
  "submitter_name" text NOT NULL,
  "submitter_address" text,
  "submitter_iban" text,
  -- Per-year sequence, rendered as "2026-001".
  "year" integer NOT NULL,
  "seq" integer NOT NULL,
  "note_number" text NOT NULL,
  "issue_date" date NOT NULL,
  "period_start" date,
  "period_end" date,
  "currency" text DEFAULT 'EUR' NOT NULL,
  "total" numeric(12, 2) DEFAULT 0 NOT NULL,
  "notes" text,
  -- draft -> posted -> paid. Only 'posted' and 'paid' carry a journal entry.
  "status" text DEFAULT 'draft' NOT NULL,
  "journal_entry_id" uuid REFERENCES "journal_entries"("id") ON DELETE SET NULL,
  "file_path" text[],
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "expense_notes_number_unique" UNIQUE ("team_id", "note_number"),
  CONSTRAINT "expense_notes_seq_unique" UNIQUE ("team_id", "year", "seq"),
  CONSTRAINT "expense_notes_status_check"
    CHECK ("status" IN ('draft', 'posted', 'paid')),
  CONSTRAINT "expense_notes_total_nonneg" CHECK ("total" >= 0)
);

CREATE INDEX "expense_notes_team_idx" ON "expense_notes" ("team_id", "issue_date" DESC);
CREATE INDEX "expense_notes_entry_idx" ON "expense_notes" ("journal_entry_id");

CREATE TABLE "expense_note_lines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "expense_note_id" uuid NOT NULL
    REFERENCES "expense_notes"("id") ON DELETE CASCADE,
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "position" integer DEFAULT 0 NOT NULL,
  "description" text NOT NULL,
  -- Free-text period label as printed ("Oktober", "Q4 2025").
  "period_label" text,
  "category" text,
  -- Which cost account this line debits. Text (not a FK) so a note can be
  -- drafted before the chart is touched; postExpenseNote resolves and fails
  -- loudly on an unknown code.
  "gl_account_code" text NOT NULL,
  -- Either a flat amount, or quantity x unit_price. When quantity is set the
  -- PDF prints the calculation ("342 kWh x 0,2872 EUR/kWh x 100%").
  "quantity" numeric(12, 4),
  "unit" text,
  "unit_price" numeric(12, 6),
  -- Share of the gross figure that is claimed (business use). Printed as the
  -- "aftrekbaar percentage" on the Astro-style note.
  "claim_pct" numeric(5, 2) DEFAULT 100 NOT NULL,
  "amount" numeric(12, 2) NOT NULL,
  -- Provenance of the rate used, e.g. "CREG forfait Q4 2025 Vlaanderen".
  "basis_note" text,
  CONSTRAINT "expense_note_lines_amount_nonneg" CHECK ("amount" >= 0),
  CONSTRAINT "expense_note_lines_pct_range"
    CHECK ("claim_pct" >= 0 AND "claim_pct" <= 100)
);

CREATE INDEX "expense_note_lines_note_idx"
  ON "expense_note_lines" ("expense_note_id", "position");

-- Guard mirroring the invoice/transaction rules (adversarial-review finding
-- from the 2026-07 pass): a note backed by a posted entry is frozen. Correct
-- it by reversing the entry first, exactly like every other booked document.
CREATE OR REPLACE FUNCTION expense_note_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_entry uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.journal_entry_id IS NOT NULL THEN
      RAISE EXCEPTION 'expense note % is booked; reverse the entry first', OLD.note_number
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  -- Amount/date/identity changes are frozen while an entry exists. Status and
  -- the pointer itself must stay writable (draft -> posted -> paid, reversal).
  IF OLD.journal_entry_id IS NOT NULL
     AND (NEW.total IS DISTINCT FROM OLD.total
       OR NEW.issue_date IS DISTINCT FROM OLD.issue_date
       OR NEW.director_id IS DISTINCT FROM OLD.director_id
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.note_number IS DISTINCT FROM OLD.note_number) THEN
    RAISE EXCEPTION 'expense note % is booked; reverse the entry first', OLD.note_number
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER expense_note_guard_trg
  BEFORE UPDATE OR DELETE ON expense_notes
  FOR EACH ROW EXECUTE FUNCTION expense_note_guard();

-- Lines of a booked note are immutable too (the entry was built from them).
CREATE OR REPLACE FUNCTION expense_note_line_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_entry uuid;
  v_number text;
BEGIN
  SELECT journal_entry_id, note_number INTO v_entry, v_number
    FROM expense_notes
   WHERE id = COALESCE(NEW.expense_note_id, OLD.expense_note_id);
  IF v_entry IS NOT NULL THEN
    RAISE EXCEPTION 'expense note % is booked; reverse the entry first', v_number
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER expense_note_line_guard_trg
  BEFORE INSERT OR UPDATE OR DELETE ON expense_note_lines
  FOR EACH ROW EXECUTE FUNCTION expense_note_line_guard();
