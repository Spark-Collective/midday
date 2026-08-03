-- 0041_director_residences.sql
-- The municipal surcharge follows where the taxpayer lived on 1 JANUARY OF THE
-- ASSESSMENT YEAR, not where they live now. A single `directors.municipality`
-- field is therefore wrong for anyone who has ever moved.
--
-- Proven by a real assessment: a taxpayer who moved from Antwerpen to Aalst in
-- April 2025 was still taxed at the Antwerpen rate for income 2024 (AJ2025),
-- because on 1 January 2025 they still lived in Antwerpen.
--
-- `directors.municipality` is kept as the CURRENT municipality (useful for
-- correspondence); the residence history is what the tax computation reads.

CREATE TABLE "director_residences" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "director_id" uuid NOT NULL REFERENCES "directors"("id") ON DELETE CASCADE,
  "municipality" text NOT NULL,
  "from_date" date NOT NULL,
  -- NULL = still living there.
  "to_date" date,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "director_residences_period_valid" CHECK ("to_date" IS NULL OR "to_date" > "from_date")
);
--> statement-breakpoint
CREATE INDEX "director_residences_lookup_idx"
  ON "director_residences" ("team_id", "director_id", "from_date");
--> statement-breakpoint
-- No two residences may cover the same day for one director.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE "director_residences" ADD CONSTRAINT "director_residences_no_overlap"
  EXCLUDE USING gist (
    "director_id" WITH =,
    daterange("from_date", COALESCE("to_date", 'infinity'::date), '[)') WITH &&
  );
--> statement-breakpoint

ALTER TABLE "director_residences" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "Team members can manage director residences" ON "director_residences" AS PERMISSIVE FOR ALL TO public USING (team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user));
