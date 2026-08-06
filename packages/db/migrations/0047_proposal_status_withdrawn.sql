-- 0047_proposal_status_withdrawn.sql
-- Widen the funnel's status CHECK to admit `withdrawn`.
--
-- The pre-existing constraint allowed draft | sent | viewed | accepted |
-- declined | expired. Midday's lifecycle adds `withdrawn`, which is how a
-- superseded offer is retired: terms cannot be edited once sent, so a revised
-- scope means withdrawing the old offer and writing a new one. Without this,
-- that path failed at the database.
--
-- Widening a CHECK cannot break the funnel: everything it wrote before is still
-- allowed. `viewed` is deliberately kept, because the funnel sets it when a
-- client opens the share link and this migration does not own that code.

ALTER TABLE "proposals" DROP CONSTRAINT IF EXISTS "proposals_status_check";
--> statement-breakpoint

ALTER TABLE "proposals"
  ADD CONSTRAINT "proposals_status_check" CHECK ("status" = ANY (ARRAY[
    'draft'::text, 'sent'::text, 'viewed'::text, 'accepted'::text,
    'declined'::text, 'expired'::text, 'withdrawn'::text
  ]));
