-- 0045_proposals.sql
-- Proposals: the priced offer plus the service-level agreement, as one document.
--
-- DELIBERATELY NOT AN INVOICE STATUS. `listings.ts` selects invoices with
-- `status NOT IN ('draft','canceled','scheduled')`, a DENYLIST, so a new 'quote'
-- status would be included by default and every quote sent would land in the VAT
-- client listing and the IC statement. Belgian invoice numbering must also be
-- unbroken and every invoice is a taxable event; a proposal is neither. Separate
-- table, separate number sequence, no path into the ledger.
--
-- The body is markdown because a Spark proposal is prose (scope, why, pricing
-- table, SLA, caveats, next steps), not line items, and because it is authored by
-- Claude Code rather than typed into a form.

CREATE TYPE "proposal_status" AS ENUM (
  'draft', 'sent', 'accepted', 'declined', 'expired', 'withdrawn'
);
--> statement-breakpoint

CREATE TABLE "proposals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "customer_id" uuid REFERENCES "customers"("id") ON DELETE SET NULL,
  -- Set when the work is tracked as a project. Accepting a proposal that has one
  -- takes over that project's expected invoice figures, so they cannot disagree.
  "project_id" uuid REFERENCES "tracker_projects"("id") ON DELETE SET NULL,
  -- Own sequence (P-2026-001). Never the invoice sequence.
  "number" text NOT NULL,
  "title" text NOT NULL,
  "status" "proposal_status" DEFAULT 'draft' NOT NULL,
  "currency" text DEFAULT 'EUR' NOT NULL,

  -- The commercial core: the only part the cash forecast reads.
  "one_off_amount" numeric(12, 2),
  "recurring_amount" numeric(12, 2),
  "recurring_interval" text,           -- 'month' | 'quarter' | 'year'
  -- Committed term in months; NULL means until cancelled.
  "recurring_months" integer,

  "valid_until" date,
  -- When the one-off will actually be billed. Acceptance date is not invoice
  -- date: signing in September for delivery in November is normal.
  "expected_invoice_date" date,

  -- The document itself, including the SLA prose.
  "body_md" text,
  -- The handful of SLA commitments worth being able to query later
  -- (responseTime, supportWindow, noticePeriodDays, uptime). Prose lives in body_md.
  "sla" jsonb,
  -- Where the sent artifact lives (SharePoint, the workspace PDF). The app does
  -- not render PDFs: that already works where these documents are written.
  "document_url" text,

  "sent_at" timestamp with time zone,
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "proposals_team_number_unique" UNIQUE ("team_id", "number"),
  CONSTRAINT "proposals_recurring_interval_valid" CHECK (
    "recurring_interval" IS NULL
    OR "recurring_interval" IN ('month', 'quarter', 'year')
  ),
  -- A recurring amount without an interval is unforecastable, and an interval
  -- without an amount is noise. Refuse both at the door.
  CONSTRAINT "proposals_recurring_complete" CHECK (
    ("recurring_amount" IS NULL) = ("recurring_interval" IS NULL)
  )
);
--> statement-breakpoint

ALTER TABLE "proposals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "Team members can manage proposals" ON "proposals" AS PERMISSIVE FOR ALL TO public USING (team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user));
--> statement-breakpoint

CREATE INDEX "proposals_team_status_idx" ON "proposals" ("team_id", "status");
--> statement-breakpoint
CREATE INDEX "proposals_customer_idx" ON "proposals" ("customer_id");
--> statement-breakpoint

-- Which proposal an invoice bills, so the forecast can net an accepted offer
-- against what has already been invoiced against it. Same reason invoices carry
-- project_id: netting by customer and date is a guess, and a guess about money
-- that is usually right is still the wrong shape.
ALTER TABLE "invoices"
  ADD COLUMN "proposal_id" uuid REFERENCES "proposals"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX "invoices_proposal_id_idx" ON "invoices" ("proposal_id");
