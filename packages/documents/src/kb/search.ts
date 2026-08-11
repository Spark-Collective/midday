/**
 * Retrieval over the indexed KB.
 *
 * Hybrid on purpose, because the two signals fail differently. Vector
 * similarity handles paraphrase ("can I put lunch with a client through the
 * company"); the Dutch `aliases` the authors wrote handle the vocabulary a
 * Belgian operator actually types ("kosten categoriseren", "vak 59"), which
 * embeddings of English-ish prose match poorly.
 *
 * Every hit carries its page's judgment fields, and the result says plainly
 * when a figure must be re-verified before use. That is the whole point: the
 * KB holds the method, the live source holds the number.
 */
import type { Pool, PoolClient } from "pg";
import { Embed } from "../embed/embed";
import { mustVerify } from "./parse";

export type KbHit = {
  path: string;
  title: string;
  heading: string | null;
  content: string;
  confidence: string | null;
  verifyLive: boolean;
  reviewAfter: string | null;
  sources: string[];
  score: number;
};

export type KbSearchResult = {
  results: KbHit[];
  mustVerify: boolean;
  guidance: string | null;
  kbVersion: string | null;
};

type Db = Pool | PoolClient;

const VERIFY_GUIDANCE =
  "At least one page below carries a figure that changes (verify_live, " +
  "medium/low confidence, or past its review date). Use web_search against " +
  "the listed sources to confirm the current value before booking, filing, " +
  "or advising. Apply the method from the KB; never quote its number as " +
  "today's fact.";

export async function searchAccountingKb(
  db: Db,
  input: { query: string; limit?: number; today?: string },
): Promise<KbSearchResult> {
  const limit = Math.min(Math.max(input.limit ?? 5, 1), 15);
  const today = input.today ?? new Date().toISOString().slice(0, 10);

  const { embedding } = await new Embed().embed(input.query);

  // Vector distance on the chunk, plus a boost when the query mentions one of
  // the document's own aliases or its title. Best chunk per document wins, so
  // one page cannot fill the whole result set.
  const res = await db.query(
    `WITH scored AS (
       SELECT d.path, d.title, d.confidence, d.verify_live, d.sources,
              d.review_after::text AS review_after,
              c.heading, c.content,
              (1 - (c.embedding <=> $1::vector)) AS vector_score,
              CASE
                WHEN EXISTS (
                  SELECT 1 FROM unnest(d.aliases) a
                   WHERE $2 ILIKE '%' || a || '%'
                ) THEN 0.25
                WHEN $2 ILIKE '%' || d.title || '%' THEN 0.15
                ELSE 0
              END AS lexical_boost,
              ROW_NUMBER() OVER (
                PARTITION BY d.id
                ORDER BY c.embedding <=> $1::vector
              ) AS rank_in_doc
         FROM kb_chunks c
         JOIN kb_documents d ON d.id = c.document_id
        WHERE c.embedding IS NOT NULL
     )
     SELECT path, title, heading, content, confidence, verify_live,
            review_after, sources,
            (vector_score + lexical_boost) AS score
       FROM scored
      WHERE rank_in_doc = 1
      ORDER BY score DESC
      LIMIT $3`,
    [JSON.stringify(embedding), input.query, limit],
  );

  const results: KbHit[] = res.rows.map((r) => ({
    path: r.path,
    title: r.title,
    heading: r.heading,
    content: r.content,
    confidence: r.confidence,
    verifyLive: r.verify_live,
    reviewAfter: r.review_after,
    sources: r.sources ?? [],
    score: Number(r.score),
  }));

  const needsVerify = results.some((r) =>
    mustVerify(
      {
        verifyLive: r.verifyLive,
        confidence: r.confidence,
        reviewAfter: r.reviewAfter,
      },
      today,
    ),
  );

  const state = await db.query(
    `SELECT commit_sha, indexed_at FROM kb_sync_state ORDER BY indexed_at DESC LIMIT 1`,
  );
  const row = state.rows[0];

  return {
    results,
    mustVerify: needsVerify,
    guidance: needsVerify ? VERIFY_GUIDANCE : null,
    kbVersion: row?.commit_sha
      ? `${String(row.commit_sha).slice(0, 7)} (indexed ${
          row.indexed_at instanceof Date
            ? row.indexed_at.toISOString().slice(0, 16).replace("T", " ")
            : String(row.indexed_at).slice(0, 16)
        } UTC)`
      : null,
  };
}
