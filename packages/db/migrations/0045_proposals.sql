-- 0045_proposals.sql
-- Bring the existing `proposals` table into Midday, rather than building a second one.
--
-- `public.proposals` already existed, written by the Spark website funnel: a
-- shareable proposal page with a token, view tracking (first_viewed_at,
-- view_count) and jsonb content blocks. It held the live Pulse Foundation
-- proposal. Creating a parallel table would have put the same document in two
-- places, which is exactly what a proposals system is supposed to stop.
--
-- So this migration is ADDITIVE ONLY. Every existing column keeps its meaning,
-- the share token and view tracking keep working, and Midday adds what was
-- missing: team scoping, the commercial core the cash forecast reads, and the
-- accept lifecycle.
--
-- DELIBERATELY NOT AN INVOICE. `listings.ts` selects invoices with
-- `status NOT IN ('draft','canceled','scheduled')`, a DENYLIST, so folding
-- proposals into invoices would put every quote into the VAT client listing and
-- the IC statement. Belgian invoice numbering must also be unbroken and every
-- invoice is a taxable event. A proposal is neither.

-- Litter from the first attempt at this migration, before the collision was
-- found. `status` deliberately stays TEXT: the funnel writes values of its own
-- ('viewed'), and an enum would make a stray write from a system this migration
-- cannot see fail hard instead of degrade.
DROP TYPE IF EXISTS "proposal_status";
--> statement-breakpoint

ALTER TABLE "proposals"
  -- Team scoping, so the app can see it under the same RLS model as everything
  -- else. Nullable: rows written by the funnel before this have no team, and
  -- they stay invisible to the app until claimed rather than leaking.
  ADD COLUMN IF NOT EXISTS "team_id" uuid REFERENCES "teams"("id") ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS "customer_id" uuid REFERENCES "customers"("id") ON DELETE SET NULL,
  -- Accepting a proposal that has a project takes over that project's expected
  -- invoice figures, so the same money is never forecast from two places.
  ADD COLUMN IF NOT EXISTS "project_id" uuid REFERENCES "tracker_projects"("id") ON DELETE SET NULL,
  -- Own sequence (P-2026-001). Never the invoice sequence.
  ADD COLUMN IF NOT EXISTS "number" text,

  -- The commercial core: the only part the cash forecast reads.
  ADD COLUMN IF NOT EXISTS "one_off_amount" numeric(12, 2),
  ADD COLUMN IF NOT EXISTS "recurring_amount" numeric(12, 2),
  ADD COLUMN IF NOT EXISTS "recurring_interval" text,
  -- Committed term in months; NULL means until cancelled.
  ADD COLUMN IF NOT EXISTS "recurring_months" integer,
  -- When the one-off gets billed. Acceptance date is not invoice date: signing
  -- in September for delivery in November is normal.
  ADD COLUMN IF NOT EXISTS "expected_invoice_date" date,

  -- The document as markdown, including the SLA section. `content` (jsonb
  -- blocks) stays for the funnel's renderer; this is what Claude Code writes.
  ADD COLUMN IF NOT EXISTS "body_md" text,
  -- The few SLA terms worth querying later (responseTime, noticePeriodDays...).
  -- The prose lives in body_md.
  ADD COLUMN IF NOT EXISTS "sla" jsonb,
  ADD COLUMN IF NOT EXISTS "document_url" text,

  ADD COLUMN IF NOT EXISTS "sent_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "decided_at" timestamp with time zone;
--> statement-breakpoint

-- `expires_at` (date) already means valid-until, so it is reused rather than
-- duplicated by a second column meaning the same thing.

ALTER TABLE "proposals"
  ADD CONSTRAINT "proposals_recurring_interval_valid" CHECK (
    "recurring_interval" IS NULL
    OR "recurring_interval" IN ('month', 'quarter', 'year')
  );
--> statement-breakpoint

-- A recurring amount with no interval is unforecastable; an interval with no
-- amount is noise. Refuse both at the door.
ALTER TABLE "proposals"
  ADD CONSTRAINT "proposals_recurring_complete" CHECK (
    ("recurring_amount" IS NULL) = ("recurring_interval" IS NULL)
  );
--> statement-breakpoint

-- 'viewed' carried two facts at once: it was sent, and the client opened it.
-- The second already lives in first_viewed_at/view_count, so collapsing the
-- status to 'sent' loses nothing and puts the row on the lifecycle.
UPDATE "proposals"
   SET "status" = 'sent',
       "sent_at" = COALESCE("sent_at", "created_at")
 WHERE "status" = 'viewed';
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "proposals_team_number_unique"
  ON "proposals" ("team_id", "number")
  WHERE "team_id" IS NOT NULL AND "number" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "proposals_team_status_idx" ON "proposals" ("team_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "proposals_customer_idx" ON "proposals" ("customer_id");
--> statement-breakpoint

-- RLS was already enabled on this table but carried NO policies, so only the
-- service key could reach it. This adds the standard team policy without
-- removing anything.
ALTER TABLE "proposals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "Team members can manage proposals" ON "proposals";
--> statement-breakpoint
CREATE POLICY "Team members can manage proposals" ON "proposals" AS PERMISSIVE FOR ALL TO public USING (team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user));
--> statement-breakpoint

-- Which proposal an invoice bills, so the forecast can net an accepted offer
-- against what has already been invoiced. Same reason invoices carry project_id:
-- netting by customer and date is a guess, and a guess about money that is
-- usually right is still the wrong shape.
ALTER TABLE "invoices"
  ADD COLUMN IF NOT EXISTS "proposal_id" uuid REFERENCES "proposals"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoices_proposal_id_idx" ON "invoices" ("proposal_id");
