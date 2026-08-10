-- 0041_asset_acquisition_value.sql
-- Give the asset register its history back.
--
-- `amortizations.amount` is the BASIS a schedule depreciates. For assets seeded
-- at a history import that basis is their net book value on the import date,
-- not what the company paid: Spark's register showed 14.115,81 against a ledger
-- gross of 17.083,91, agreeing only on net book value. Correct, but it meant
-- the register could never print a true acquisition column and could only
-- reconcile on NBV.
--
-- Two nullable columns fix that without touching the engine:
--   acquisition_value    what was actually paid (incl. non-deductible VAT,
--                        which is part of the cost base in Belgium)
--   accumulated_at_start depreciation already booked before the register began
--
-- The identity that must hold once both are set:
--   acquisition_value - accumulated_at_start = amount   (the opening basis)
--
-- Nullable on purpose: an asset created inside the register has no prior
-- history, and a company that never imported one should not be forced to
-- invent numbers. The register reports gross only when every row has them.

ALTER TABLE "amortizations"
  ADD COLUMN IF NOT EXISTS "acquisition_value" numeric(12, 2),
  ADD COLUMN IF NOT EXISTS "accumulated_at_start" numeric(12, 2);

COMMENT ON COLUMN "amortizations"."acquisition_value" IS
  'Original cost incl. non-deductible VAT. NULL when unknown; the register then reports basis only.';
COMMENT ON COLUMN "amortizations"."accumulated_at_start" IS
  'Depreciation booked before this schedule began. acquisition_value - accumulated_at_start = amount.';

-- Guard the identity rather than trusting the backfill: a row carrying both
-- values must be internally consistent, or the gross reconciliation silently
-- lies. One cent of tolerance for rounding.
ALTER TABLE "amortizations"
  ADD CONSTRAINT "amortizations_acquisition_identity" CHECK (
    acquisition_value IS NULL
    OR accumulated_at_start IS NULL
    OR ABS(acquisition_value - accumulated_at_start - amount) <= 0.01
  );
