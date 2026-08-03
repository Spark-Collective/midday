-- 0042_minfin_tokens.sql
-- Server-side MinFin OAuth tokens, so the app can submit to Intervat without a
-- human running the CLI.
--
-- OWNERSHIP WARNING: FPS refresh tokens are single-use and rotate on every
-- refresh. Exactly one holder can refresh a given token. Once a row here is
-- populated for an environment and the server refreshes it, the operator's local
-- `spark-minfin` CLI must STOP refreshing that environment (drop it from the
-- keepalive) or the two will keep invalidating each other.
--
-- The refresh token is a bearer credential. It sits alongside the bank
-- connection tokens this database already holds, under the same RLS model.

CREATE TABLE "minfin_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  -- 'test' | 'prod'
  "env" text NOT NULL,
  "refresh_token" text NOT NULL,
  "access_token" text,
  "expires_in" integer,
  -- Unix seconds when the current set was obtained.
  "obtained_at" bigint,
  "scope" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "minfin_tokens_team_env_unique" UNIQUE ("team_id", "env"),
  CONSTRAINT "minfin_tokens_env_valid" CHECK ("env" IN ('test', 'prod'))
);
--> statement-breakpoint

ALTER TABLE "minfin_tokens" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "Team members can manage minfin tokens" ON "minfin_tokens" AS PERMISSIVE FOR ALL TO public USING (team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user));
