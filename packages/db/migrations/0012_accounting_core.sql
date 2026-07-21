-- 0012_accounting_core.sql
-- Accounting module M0: double-entry ledger core.
-- Design: docs/architecture/midday-accounting-implementation-plan-2026-07-20.md
-- (spark-workspace). All hard invariants live HERE, in Postgres (I1-I8):
--   I1 posted entries balance (functional currency)
--   I2 posted lines are immutable (correct via reversal, never UPDATE)
--   I3 entries post only into open fiscal periods (and the period matches the date)
--   I4 account-currency locks
--   I5 idempotent posting per source document
--   I6 no postings to group accounts
--   I8 RLS team isolation
-- (I7, per-currency netting, is a soft engine-level warning by design.)

-- F1: FX rates need real precision (EUR/USD 0.9234 stored as 0.92 = 1.5% error).
ALTER TABLE "exchange_rates" ALTER COLUMN "rate" SET DATA TYPE numeric(20, 10);
--> statement-breakpoint

CREATE TYPE "gl_account_type" AS ENUM ('asset', 'liability', 'equity', 'income', 'expense');
--> statement-breakpoint
CREATE TYPE "journal_type" AS ENUM ('sales', 'purchase', 'bank', 'cash', 'general');
--> statement-breakpoint
CREATE TYPE "fiscal_period_status" AS ENUM ('open', 'closed');
--> statement-breakpoint
CREATE TYPE "journal_entry_status" AS ENUM ('draft', 'posted', 'reversed');
--> statement-breakpoint
CREATE TYPE "journal_entry_source" AS ENUM ('invoice', 'transaction', 'reconciliation', 'revaluation', 'depreciation', 'opening', 'manual');
--> statement-breakpoint
CREATE TYPE "ledger_party_type" AS ENUM ('customer', 'supplier', 'employee');
--> statement-breakpoint
CREATE TYPE "tax_kind" AS ENUM ('standard', 'reduced', 'zero', 'intra_eu', 'export', 'reverse_charge', 'exempt');
--> statement-breakpoint

CREATE TABLE "gl_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "type" "gl_account_type" NOT NULL,
  "parent_id" uuid REFERENCES "gl_accounts"("id"),
  "is_group" boolean DEFAULT false NOT NULL,
  "currency" text,
  "system_key" text,
  "vat_deductible_pct" numeric(5, 2),
  "vu_category" text,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "gl_accounts_team_code_unique" UNIQUE ("team_id", "code"),
  CONSTRAINT "gl_accounts_vat_pct_range" CHECK ("vat_deductible_pct" IS NULL OR ("vat_deductible_pct" >= 0 AND "vat_deductible_pct" <= 100))
);
--> statement-breakpoint
CREATE INDEX "gl_accounts_team_idx" ON "gl_accounts" ("team_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "gl_accounts_team_system_key_idx" ON "gl_accounts" ("team_id", "system_key") WHERE system_key IS NOT NULL;
--> statement-breakpoint

CREATE TABLE "journals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "type" "journal_type" NOT NULL,
  "bank_account_id" uuid,
  "active" boolean DEFAULT true NOT NULL,
  CONSTRAINT "journals_team_code_unique" UNIQUE ("team_id", "code")
);
--> statement-breakpoint
CREATE INDEX "journals_team_idx" ON "journals" ("team_id");
--> statement-breakpoint

CREATE TABLE "fiscal_periods" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "year" integer NOT NULL,
  "month" integer NOT NULL,
  "status" "fiscal_period_status" DEFAULT 'open' NOT NULL,
  CONSTRAINT "fiscal_periods_team_year_month_unique" UNIQUE ("team_id", "year", "month"),
  CONSTRAINT "fiscal_periods_month_range" CHECK ("month" >= 1 AND "month" <= 12)
);
--> statement-breakpoint
CREATE INDEX "fiscal_periods_team_idx" ON "fiscal_periods" ("team_id");
--> statement-breakpoint

CREATE TABLE "journal_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "journal_id" uuid NOT NULL REFERENCES "journals"("id"),
  "entry_number" text,
  "date" date NOT NULL,
  "period_id" uuid NOT NULL REFERENCES "fiscal_periods"("id"),
  "status" "journal_entry_status" DEFAULT 'draft' NOT NULL,
  "source_type" "journal_entry_source",
  "source_id" uuid,
  "source_version" integer DEFAULT 1 NOT NULL,
  "reverses_entry_id" uuid REFERENCES "journal_entries"("id"),
  "is_revaluation" boolean DEFAULT false NOT NULL,
  "narration" text,
  "posted_at" timestamp with time zone,
  "posted_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "journal_entries_team_date_idx" ON "journal_entries" ("team_id", "date");
--> statement-breakpoint
CREATE INDEX "journal_entries_journal_idx" ON "journal_entries" ("journal_id");
--> statement-breakpoint
-- I5: idempotent posting per source document version.
CREATE UNIQUE INDEX "uq_journal_entries_source" ON "journal_entries" ("team_id", "source_type", "source_id", "source_version") WHERE status = 'posted' AND source_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_journal_entries_number" ON "journal_entries" ("journal_id", "entry_number") WHERE entry_number IS NOT NULL;
--> statement-breakpoint

CREATE TABLE "ledger_lines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "entry_id" uuid NOT NULL REFERENCES "journal_entries"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL REFERENCES "gl_accounts"("id"),
  "debit" numeric(10, 2) DEFAULT 0 NOT NULL,
  "credit" numeric(10, 2) DEFAULT 0 NOT NULL,
  "currency" text NOT NULL,
  "amount_currency" numeric(10, 2) NOT NULL,
  "fx_rate" numeric(20, 10) DEFAULT 1 NOT NULL,
  "party_type" "ledger_party_type",
  "party_id" uuid,
  "tax_code_id" uuid,
  "tax_base" numeric(10, 2),
  "vat_deductible_pct_used" numeric(5, 2),
  "itax_deductible_pct_override" numeric(5, 2),
  "reconciliation_id" uuid,
  "analytic" jsonb,
  "description" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- one side only, never negative, never empty
  CONSTRAINT "ledger_lines_one_side" CHECK ("debit" >= 0 AND "credit" >= 0 AND ("debit" = 0 OR "credit" = 0) AND ("debit" + "credit" > 0)),
  CONSTRAINT "ledger_lines_fx_rate_positive" CHECK ("fx_rate" > 0),
  CONSTRAINT "ledger_lines_party_pair" CHECK (("party_type" IS NULL) = ("party_id" IS NULL))
);
--> statement-breakpoint
CREATE INDEX "ledger_lines_entry_idx" ON "ledger_lines" ("entry_id");
--> statement-breakpoint
CREATE INDEX "ledger_lines_team_account_idx" ON "ledger_lines" ("team_id", "account_id");
--> statement-breakpoint
CREATE INDEX "ledger_lines_party_idx" ON "ledger_lines" ("team_id", "party_type", "party_id");
--> statement-breakpoint
CREATE INDEX "ledger_lines_reconciliation_idx" ON "ledger_lines" ("reconciliation_id");
--> statement-breakpoint

CREATE TABLE "tax_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "rate" numeric(10, 2) NOT NULL,
  "kind" "tax_kind" NOT NULL,
  "account_id" uuid,
  "grids" jsonb,
  "verified" boolean DEFAULT false NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  CONSTRAINT "tax_codes_team_code_unique" UNIQUE ("team_id", "code")
);
--> statement-breakpoint

CREATE TABLE "vu_rates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "category" text NOT NULL,
  "fiscal_year" integer NOT NULL,
  "deductible_pct" numeric(5, 2) NOT NULL,
  CONSTRAINT "vu_rates_team_category_year_unique" UNIQUE ("team_id", "category", "fiscal_year"),
  CONSTRAINT "vu_rates_pct_range" CHECK ("deductible_pct" >= 0 AND "deductible_pct" <= 100)
);
--> statement-breakpoint

CREATE TABLE "reconciliations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "status" text DEFAULT 'open' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE "reconciliation_allocations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "debit_line_id" uuid NOT NULL REFERENCES "ledger_lines"("id"),
  "credit_line_id" uuid NOT NULL REFERENCES "ledger_lines"("id"),
  "amount" numeric(10, 2) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "reconciliation_allocations_amount_positive" CHECK ("amount" > 0)
);
--> statement-breakpoint
CREATE INDEX "reconciliation_allocations_debit_idx" ON "reconciliation_allocations" ("debit_line_id");
--> statement-breakpoint
CREATE INDEX "reconciliation_allocations_credit_idx" ON "reconciliation_allocations" ("credit_line_id");
--> statement-breakpoint

-- I8: RLS, standard Midday team isolation.
ALTER TABLE "gl_accounts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "journals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fiscal_periods" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "journal_entries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ledger_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tax_codes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "vu_rates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "reconciliations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "reconciliation_allocations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "Team members can manage gl accounts" ON "gl_accounts" AS PERMISSIVE FOR ALL TO public USING (team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user));
--> statement-breakpoint
CREATE POLICY "Team members can manage journals" ON "journals" AS PERMISSIVE FOR ALL TO public USING (team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user));
--> statement-breakpoint
CREATE POLICY "Team members can manage fiscal periods" ON "fiscal_periods" AS PERMISSIVE FOR ALL TO public USING (team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user));
--> statement-breakpoint
CREATE POLICY "Team members can manage journal entries" ON "journal_entries" AS PERMISSIVE FOR ALL TO public USING (team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user));
--> statement-breakpoint
CREATE POLICY "Team members can manage ledger lines" ON "ledger_lines" AS PERMISSIVE FOR ALL TO public USING (team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user));
--> statement-breakpoint
CREATE POLICY "Team members can manage tax codes" ON "tax_codes" AS PERMISSIVE FOR ALL TO public USING (team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user));
--> statement-breakpoint
CREATE POLICY "Team members can manage vu rates" ON "vu_rates" AS PERMISSIVE FOR ALL TO public USING (team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user));
--> statement-breakpoint
CREATE POLICY "Team members can manage reconciliations" ON "reconciliations" AS PERMISSIVE FOR ALL TO public USING (team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user));
--> statement-breakpoint
CREATE POLICY "Team members can manage reconciliation allocations" ON "reconciliation_allocations" AS PERMISSIVE FOR ALL TO public USING (team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Invariant triggers. The whole point of this module: a buggy client cannot
-- corrupt the ledger, only Postgres decides what posts.
-- ---------------------------------------------------------------------------

-- Entries must be born as drafts (posting runs the validation transition).
CREATE OR REPLACE FUNCTION accounting_entry_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'draft' THEN
    RAISE EXCEPTION 'journal entries must be created as draft (got %)', NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER trg_entry_insert_guard BEFORE INSERT ON "journal_entries"
FOR EACH ROW EXECUTE FUNCTION accounting_entry_insert_guard();
--> statement-breakpoint

-- I1 + I3 on the draft->posted transition; I2 afterwards (posted rows may only
-- flip to reversed, byte-identical otherwise; reversed rows are frozen).
CREATE OR REPLACE FUNCTION accounting_entry_update_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_debit numeric;
  v_credit numeric;
  v_lines integer;
  v_period fiscal_periods%ROWTYPE;
BEGIN
  IF OLD.status = 'draft' AND NEW.status = 'posted' THEN
    SELECT * INTO v_period FROM fiscal_periods WHERE id = NEW.period_id;
    IF v_period.status <> 'open' THEN
      RAISE EXCEPTION 'cannot post into closed period %-%', v_period.year, v_period.month
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_period.year <> EXTRACT(YEAR FROM NEW.date) OR v_period.month <> EXTRACT(MONTH FROM NEW.date) THEN
      RAISE EXCEPTION 'entry date % does not fall in period %-%', NEW.date, v_period.year, v_period.month
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0), COUNT(*)
      INTO v_debit, v_credit, v_lines
      FROM ledger_lines WHERE entry_id = NEW.id;
    IF v_lines < 2 THEN
      RAISE EXCEPTION 'entry needs at least 2 lines to post (has %)', v_lines
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_debit <> v_credit THEN
      RAISE EXCEPTION 'entry does not balance: debit % <> credit %', v_debit, v_credit
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.posted_at IS NULL THEN
      NEW.posted_at := now();
    END IF;
    RETURN NEW;
  ELSIF OLD.status = 'draft' THEN
    RETURN NEW; -- drafts are freely editable
  ELSIF OLD.status = 'posted' THEN
    IF NEW.status = 'reversed'
       AND to_jsonb(NEW) - 'status' = to_jsonb(OLD) - 'status' THEN
      RETURN NEW; -- the only legal mutation of a posted entry
    END IF;
    RAISE EXCEPTION 'posted entries are immutable (correct via a reversal entry)'
      USING ERRCODE = 'check_violation';
  ELSE
    RAISE EXCEPTION 'reversed entries are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
END $$;
--> statement-breakpoint
CREATE TRIGGER trg_entry_update_guard BEFORE UPDATE ON "journal_entries"
FOR EACH ROW EXECUTE FUNCTION accounting_entry_update_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION accounting_entry_delete_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'only draft entries can be deleted'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER trg_entry_delete_guard BEFORE DELETE ON "journal_entries"
FOR EACH ROW EXECUTE FUNCTION accounting_entry_delete_guard();
--> statement-breakpoint

-- I2/I4/I6: lines exist only under draft entries; accounts must be postable
-- (active, not a group), currency-locked accounts only take their currency,
-- and team ids must agree across line, entry, and account.
CREATE OR REPLACE FUNCTION accounting_line_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status journal_entry_status;
  v_entry_team uuid;
  v_acct gl_accounts%ROWTYPE;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT status INTO v_status FROM journal_entries WHERE id = OLD.entry_id;
    IF v_status <> 'draft' THEN
      RAISE EXCEPTION 'lines of a % entry are immutable', v_status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  SELECT status, team_id INTO v_status, v_entry_team
    FROM journal_entries WHERE id = NEW.entry_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'entry % not found', NEW.entry_id USING ERRCODE = 'check_violation';
  END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'cannot add lines to a % entry', v_status
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_entry_team <> NEW.team_id THEN
    RAISE EXCEPTION 'line team does not match entry team'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_acct FROM gl_accounts WHERE id = NEW.account_id;
  IF v_acct.id IS NULL THEN
    RAISE EXCEPTION 'account % not found', NEW.account_id USING ERRCODE = 'check_violation';
  END IF;
  IF v_acct.team_id <> NEW.team_id THEN
    RAISE EXCEPTION 'account belongs to another team' USING ERRCODE = 'check_violation';
  END IF;
  IF v_acct.is_group THEN
    RAISE EXCEPTION 'cannot post to group account %', v_acct.code
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT v_acct.active THEN
    RAISE EXCEPTION 'account % is inactive', v_acct.code USING ERRCODE = 'check_violation';
  END IF;
  IF v_acct.currency IS NOT NULL AND v_acct.currency <> NEW.currency THEN
    RAISE EXCEPTION 'account % only accepts % (got %)', v_acct.code, v_acct.currency, NEW.currency
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER trg_line_guard BEFORE INSERT OR UPDATE OR DELETE ON "ledger_lines"
FOR EACH ROW EXECUTE FUNCTION accounting_line_guard();
