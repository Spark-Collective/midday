-- 0043_cash_forecast.sql
-- Forward-looking cash: the two facts the database could not express, plus a
-- monthly snapshot so forecasts can be scored against what actually happened.
--
-- Landed-but-uninvoiced work lives on tracker_projects rather than in a new
-- deals table: that table already carries customer, rate, currency, estimate and
-- billable, and time entries already say how much of the estimate is consumed.
-- A separate pipeline table would need those numbers keyed in by hand.
-- Prospective (unsold) work stays in the CRM; this column is for work already won.

ALTER TABLE "tracker_projects"
  ADD COLUMN "expected_invoice_date" date,
  -- Fixed fee. NULL means hourly, so the value is estimate x rate.
  ADD COLUMN "contract_value" numeric(10, 2);
--> statement-breakpoint

-- Which project an invoice bills. Without this, "how much of this project is
-- still unbilled" can only be guessed at from customer and date, and a guess
-- that is wrong double counts cash. Nullable: existing invoices have no project,
-- and the forecast warns rather than nets when the link is missing.
ALTER TABLE "invoices"
  ADD COLUMN "project_id" uuid REFERENCES "tracker_projects"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX "invoices_project_id_idx" ON "invoices" ("project_id");
--> statement-breakpoint

-- Snapshots exist to measure the forecast against reality: the payment-lag model
-- only improves if its errors are recorded. `buckets` holds the full computed
-- curve as rendered on `taken_on`, so a later comparison sees exactly what was
-- claimed, not a recomputation from today's data.
CREATE TABLE "cash_forecast_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "taken_on" date NOT NULL,
  "opening_balance" numeric(14, 2) NOT NULL,
  "currency" text NOT NULL,
  "buckets" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "cash_forecast_snapshots_team_date_unique" UNIQUE ("team_id", "taken_on")
);
--> statement-breakpoint

ALTER TABLE "cash_forecast_snapshots" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "Team members can manage cash forecast snapshots" ON "cash_forecast_snapshots" AS PERMISSIVE FOR ALL TO public USING (team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user));
--> statement-breakpoint

CREATE INDEX "cash_forecast_snapshots_team_taken_on_idx" ON "cash_forecast_snapshots" ("team_id", "taken_on" DESC);
