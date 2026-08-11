-- 0051_accounting_kb.sql
-- The Belgian accounting knowledge graph, indexed for retrieval.
--
-- Source of truth is and stays the public GitHub repo
-- (Spark-Collective/accounting-knowledge-graph). Everything here is DERIVED
-- and disposable: drop it and the next sync rebuilds it. Nothing in Midday
-- ever writes back.
--
-- Deliberately NOT team-scoped. Belgian accounting practice is identical for
-- every company on the instance, unlike vault documents. Team scoping here
-- would mean N copies of the same 80 pages and N times the embedding cost.

CREATE TABLE "kb_documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- Path inside the repo; the natural key, and what a citation shows.
  "path" text NOT NULL UNIQUE,
  "title" text NOT NULL,
  "description" text,
  "type" text,
  "tags" text[] DEFAULT '{}' NOT NULL,
  -- Dutch search terms the author wrote for exactly this purpose.
  "aliases" text[] DEFAULT '{}' NOT NULL,
  -- The KB's own judgment fields. These drive the verify-before-use rule,
  -- so they are columns, not buried in a jsonb blob.
  "confidence" text,
  "verify_live" boolean DEFAULT false NOT NULL,
  "review_after" date,
  "sources" text[] DEFAULT '{}' NOT NULL,
  "content" text NOT NULL,
  -- Git blob sha of the file. The tree API hands us this for free, so a sync
  -- can tell what changed without downloading anything.
  "content_sha" text NOT NULL,
  "commit_sha" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX "kb_documents_tags_idx" ON "kb_documents" USING gin ("tags");
CREATE INDEX "kb_documents_aliases_idx" ON "kb_documents" USING gin ("aliases");
CREATE INDEX "kb_documents_title_trgm_idx"
  ON "kb_documents" USING gin ("title" gin_trgm_ops);

CREATE TABLE "kb_chunks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "document_id" uuid NOT NULL
    REFERENCES "kb_documents"("id") ON DELETE CASCADE,
  "position" integer DEFAULT 0 NOT NULL,
  -- The '##' section this chunk came from; shown so a quoted passage can be
  -- traced back to a place in the page.
  "heading" text,
  "content" text NOT NULL,
  -- 768 dims: matches gemini-embedding-001 as configured in
  -- packages/documents/src/embed/embed.ts. Changing either without the other
  -- silently breaks similarity.
  "embedding" vector(768)
);

CREATE INDEX "kb_chunks_document_idx" ON "kb_chunks" ("document_id", "position");
CREATE INDEX "kb_chunks_embedding_idx" ON "kb_chunks"
  USING hnsw ("embedding" vector_cosine_ops);
CREATE INDEX "kb_chunks_content_trgm_idx"
  ON "kb_chunks" USING gin ("content" gin_trgm_ops);

-- One row per indexed repo: what we have, and when we learned it. Makes a
-- stale index visible instead of silent, and lets every answer name the KB
-- version behind it.
CREATE TABLE "kb_sync_state" (
  "repo" text PRIMARY KEY,
  "commit_sha" text,
  "indexed_at" timestamp with time zone,
  "document_count" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "last_checked_at" timestamp with time zone
);
