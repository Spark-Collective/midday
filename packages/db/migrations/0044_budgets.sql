-- 0044_budgets.sql
-- Planned spend per category per month.
--
-- Monthly only, deliberately. An annual cost (insurance, the accountant) belongs
-- in the month it actually leaves the bank: smearing it over twelve months is
-- fine for a P&L and wrong for cash, and this table feeds the cash forecast.
-- An annual view is just twelve months summed.
--
-- Spend only. Budgeting income is forecasting, and that is what landed work and
-- open invoices are for.

CREATE TABLE "budgets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "category_slug" text NOT NULL,
  -- 'YYYY-MM'
  "period_key" text NOT NULL,
  -- Positive = planned spend.
  "amount" numeric(14, 2) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "budgets_team_category_period_unique" UNIQUE ("team_id", "category_slug", "period_key"),
  CONSTRAINT "budgets_period_key_shape" CHECK ("period_key" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT "budgets_amount_not_negative" CHECK ("amount" >= 0)
);
--> statement-breakpoint

ALTER TABLE "budgets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "Team members can manage budgets" ON "budgets" AS PERMISSIVE FOR ALL TO public USING (team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user));
--> statement-breakpoint

CREATE INDEX "budgets_team_period_idx" ON "budgets" ("team_id", "period_key");
