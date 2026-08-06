-- 0048_drop_project_forecast_fields.sql
-- Remove the duplicate way into the cash forecast.
--
-- `tracker_projects.expected_invoice_date` and `contract_value` were added in
-- 0043 as the place to record landed work. Proposals (0045) replaced that: an
-- accepted offer is a dated fact with a document behind it, where a typed
-- project field was a guess. Since accepting a proposal already took over its
-- project's figures, these two columns were only reachable for work that never
-- had a proposal, and with proposals authored from Claude Code that is
-- approaching never.
--
-- Two ways to describe the same money is the failure this whole area exists to
-- prevent, so the weaker one goes. `invoices.project_id` STAYS: linking an
-- invoice to the project it bills is about delivery and profitability, not
-- forecasting, and nothing duplicates it.

ALTER TABLE "tracker_projects"
  DROP COLUMN IF EXISTS "expected_invoice_date",
  DROP COLUMN IF EXISTS "contract_value";
