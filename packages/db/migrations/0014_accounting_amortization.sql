-- 0014_accounting_amortization.sql
-- Accounting M4b + M5: one amortization engine for fixed assets AND cost
-- deferrals (S4 — the books show both as the same monthly mechanic), plus the
-- verworpen-uitgaven year report (§5b.1: extra-comptabel, a view, never postings).

CREATE TYPE "amortization_kind" AS ENUM ('asset', 'deferral');
--> statement-breakpoint

CREATE TABLE "amortizations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "kind" "amortization_kind" NOT NULL,
  "name" text NOT NULL,
  -- monthly charge hits this account (6302x for assets, the cost account for deferrals)
  "charge_account_id" uuid NOT NULL REFERENCES "gl_accounts"("id"),
  -- the balance melts here (2xx9 accumulated for assets, 490000 for deferrals)
  "balance_account_id" uuid NOT NULL REFERENCES "gl_accounts"("id"),
  -- assets only: the 2xx cost account, needed for disposal
  "asset_account_id" uuid REFERENCES "gl_accounts"("id"),
  "source_ref" text,
  "start_date" date NOT NULL,
  "months" integer NOT NULL,
  "amount" numeric(10, 2) NOT NULL,
  "residual_value" numeric(10, 2) DEFAULT 0 NOT NULL,
  -- ponytail: monthly pro-rata only; daily / full-first-year variants arrive
  -- with a KB-verified config if ever needed
  "status" text DEFAULT 'active' NOT NULL, -- active | completed | disposed
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "amortizations_months_positive" CHECK ("months" > 0),
  CONSTRAINT "amortizations_amount_positive" CHECK ("amount" > 0),
  CONSTRAINT "amortizations_residual_range" CHECK ("residual_value" >= 0 AND "residual_value" < "amount")
);
--> statement-breakpoint
CREATE INDEX "amortizations_team_idx" ON "amortizations" ("team_id");
--> statement-breakpoint

-- The POSTED record per item per period (the schedule itself is deterministic
-- from start_date/months/amount and computed on the fly).
CREATE TABLE "amortization_lines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "amortization_id" uuid NOT NULL REFERENCES "amortizations"("id") ON DELETE CASCADE,
  "period_id" uuid NOT NULL REFERENCES "fiscal_periods"("id"),
  "amount" numeric(10, 2) NOT NULL,
  "entry_id" uuid REFERENCES "journal_entries"("id"),
  CONSTRAINT "amortization_lines_item_period_unique" UNIQUE ("amortization_id", "period_id")
);
--> statement-breakpoint
CREATE INDEX "amortization_lines_team_idx" ON "amortization_lines" ("team_id");
--> statement-breakpoint

ALTER TABLE "amortizations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "amortization_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "Team members can manage amortizations" ON "amortizations" AS PERMISSIVE FOR ALL TO public USING (team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user));
--> statement-breakpoint
CREATE POLICY "Team members can manage amortization lines" ON "amortization_lines" AS PERMISSIVE FOR ALL TO public USING (team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user));
--> statement-breakpoint

-- Verworpen uitgaven (§5b.1): extra-comptabel add-backs per category per fiscal
-- year. Expense accounts carry vu_category; the year rate comes from vu_rates.
-- A category with expenses but no rate row shows deductible_pct NULL — a
-- visible gap, never a silent 100%.
CREATE VIEW "v_verworpen_uitgaven" WITH (security_invoker = true) AS
SELECT
  ll.team_id,
  EXTRACT(YEAR FROM je.date)::int AS fiscal_year,
  a.vu_category,
  SUM(ll.debit - ll.credit) AS expense_base,
  vr.deductible_pct,
  ROUND(SUM(ll.debit - ll.credit) * (100 - vr.deductible_pct) / 100, 2) AS disallowed_amount
FROM ledger_lines ll
JOIN journal_entries je ON je.id = ll.entry_id AND je.status = 'posted'
JOIN gl_accounts a ON a.id = ll.account_id AND a.vu_category IS NOT NULL
LEFT JOIN vu_rates vr ON vr.team_id = ll.team_id
  AND vr.category = a.vu_category
  AND vr.fiscal_year = EXTRACT(YEAR FROM je.date)::int
GROUP BY ll.team_id, EXTRACT(YEAR FROM je.date), a.vu_category, vr.deductible_pct;
