-- 0039_compliance_workflows.sql
-- Compliance layer C1 + C3 foundation: the year as a sequence of obligations, and
-- the directors behind a one-person (or N-person) BV.
-- Design: docs/architecture/midday-compliance-workflows-2026-08-02.md (spark-workspace).
--
-- Numbering note: the accounting series ran 0012..0016 in parallel with upstream's
-- own 0012.. files. This one takes the global next number (upstream head 0038) so
-- there is exactly one 0039 and ordering is unambiguous.
--
-- Four tables:
--   filings          one row per obligation instance; drives the calendar AND the stepper
--   tax_parameters   yearly rates/thresholds as DATA (never literals in code), with provenance
--   directors        N per team; each has their own R/C account
--   director_items   personal-side amounts that are not in the company books

CREATE TYPE "filing_kind" AS ENUM (
  'vat_return', 'client_listing', 'ic_statement',
  'annual_accounts', 'corporate_tax',
  'personal_tax', 'social_contribution', 'advance_payment'
);
--> statement-breakpoint
CREATE TYPE "filing_status" AS ENUM (
  'not_started', 'in_progress', 'ready_for_review', 'filed', 'confirmed', 'skipped'
);
--> statement-breakpoint

CREATE TABLE "directors" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "name" text NOT NULL,
  -- Rijksregisternummer: needed to file, special-category-adjacent. Never render in
  -- full in UI or logs; encryption at rest is a C4 decision (see the design doc).
  "national_number" text,
  "social_insurance_fund" text,
  "fund_client_number" text,
  "status" text,                                   -- hoofdberoep | bijberoep | gepensioneerd
  -- This director's own current account (R/C). Two directors must never share one.
  "gl_account_id" uuid REFERENCES "gl_accounts"("id"),
  "remuneration_monthly" numeric(10, 2),           -- the plan, not the postings
  "withholding_pct" numeric(5, 2),
  "marital_status" text,
  "dependent_children" integer DEFAULT 0 NOT NULL,
  "municipality" text,                             -- drives the municipal surcharge
  "active" boolean DEFAULT true NOT NULL,
  "started_on" date,
  "ended_on" date,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "directors_team_name_unique" UNIQUE ("team_id", "name"),
  CONSTRAINT "directors_gl_account_unique" UNIQUE ("gl_account_id")
);
--> statement-breakpoint
CREATE INDEX "directors_team_idx" ON "directors" ("team_id");
--> statement-breakpoint

CREATE TABLE "filings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  -- null for company filings; set for personal_tax (one per director per year)
  "director_id" uuid REFERENCES "directors"("id") ON DELETE CASCADE,
  "kind" "filing_kind" NOT NULL,
  "period_year" integer NOT NULL,
  "period_key" text NOT NULL,                      -- '2026Q3' | '2026' | '2026M07'
  "due_date" date NOT NULL,
  "status" "filing_status" DEFAULT 'not_started' NOT NULL,
  "steps" jsonb DEFAULT '[]'::jsonb NOT NULL,      -- [{key,label,kind,status,doneAt,note}]
  "data" jsonb,                                    -- computed payload (grids, tax totals)
  "artifacts" jsonb DEFAULT '[]'::jsonb NOT NULL,  -- [{label, documentId|url|reference}]
  "entry_id" uuid REFERENCES "journal_entries"("id"),
  "external_ref" text,                             -- Intervat proof uuid, NBB deposit nr
  "filed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- One obligation instance per (team, kind, period) — and per director where set.
-- Two partial indexes because NULL never equals NULL in a plain UNIQUE.
CREATE UNIQUE INDEX "filings_company_period_unique"
  ON "filings" ("team_id", "kind", "period_key")
  WHERE "director_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "filings_director_period_unique"
  ON "filings" ("team_id", "kind", "period_key", "director_id")
  WHERE "director_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "filings_team_due_idx" ON "filings" ("team_id", "due_date");
--> statement-breakpoint

CREATE TABLE "director_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "director_id" uuid NOT NULL REFERENCES "directors"("id") ON DELETE CASCADE,
  "year" integer NOT NULL,
  "kind" text NOT NULL,                            -- personal_advance_payment | vapz_premium | ...
  "amount" numeric(10, 2) NOT NULL,
  "paid_on" date,
  "note" text,
  "document_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "director_items_lookup_idx" ON "director_items" ("team_id", "director_id", "year");
--> statement-breakpoint

-- Global reference data: rates, thresholds, coefficients. Every computed figure
-- resolves through here, so the product can always answer "where does this number
-- come from and when did a human last check it?".
CREATE TABLE "tax_parameters" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "year" integer NOT NULL,
  "key" text NOT NULL,
  "value" numeric(14, 4) NOT NULL,
  "unit" text,                                     -- 'EUR' | 'pct' | 'ratio'
  "source_url" text,
  "verified_on" date,                              -- NULL = never verified against the source
  "verified_by" text,
  "note" text,
  CONSTRAINT "tax_parameters_year_key_unique" UNIQUE ("year", "key")
);
--> statement-breakpoint

ALTER TABLE "directors" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "filings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "director_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tax_parameters" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "Team members can manage directors" ON "directors" AS PERMISSIVE FOR ALL TO public USING (team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user));
--> statement-breakpoint
CREATE POLICY "Team members can manage filings" ON "filings" AS PERMISSIVE FOR ALL TO public USING (team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user));
--> statement-breakpoint
CREATE POLICY "Team members can manage director items" ON "director_items" AS PERMISSIVE FOR ALL TO public USING (team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user));
--> statement-breakpoint
-- Reference data: readable by everyone, written by the service role (seed script).
CREATE POLICY "Anyone can read tax parameters" ON "tax_parameters" AS PERMISSIVE FOR SELECT TO public USING (true);
--> statement-breakpoint

-- Keep updated_at honest without app-layer discipline.
CREATE OR REPLACE FUNCTION filings_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER filings_touch BEFORE UPDATE ON "filings"
  FOR EACH ROW EXECUTE FUNCTION filings_touch_updated_at();
