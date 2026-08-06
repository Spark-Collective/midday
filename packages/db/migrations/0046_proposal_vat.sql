-- 0046_proposal_vat.sql
-- Proposal amounts are quoted NET; cash moves GROSS.
--
-- A B2B offer says "EUR 11.000" meaning excluding VAT, which is what the client
-- signs. The cash forecast is deliberately gross of VAT (an invoice of 12.100
-- moves 12.100, and the VAT leaves later on its own filing date), and
-- `invoices.amount` is VAT-inclusive, as `listings.ts` shows by computing
-- turnover as `amount - vat`.
--
-- So without this, two things were wrong at once: every proposal understated the
-- cash it would produce by the VAT rate, and netting an accepted offer against
-- what had been invoiced compared a net figure with a gross one.
--
-- 21 is the Belgian standard rate and the right default here. Set 0 for reverse
-- charge (intra-EU B2B with a valid VAT number) and for customers outside the EU.

ALTER TABLE "proposals"
  ADD COLUMN IF NOT EXISTS "vat_rate" numeric(5, 2) NOT NULL DEFAULT 21;
--> statement-breakpoint

ALTER TABLE "proposals"
  ADD CONSTRAINT "proposals_vat_rate_range" CHECK ("vat_rate" >= 0 AND "vat_rate" <= 100);
