/**
 * Keeping the indexed KB in step with GitHub.
 *
 * Cheap by construction: compare the repo's head sha with what we indexed
 * (one request). If it moved, list the tree (one request) and re-embed only
 * the files whose blob sha changed. Paths that disappeared are deleted, so a
 * page removed upstream stops being quotable here.
 *
 * Idempotent and restartable: state lives in kb_sync_state, and a failure is
 * recorded rather than swallowed, so a silently stale index is impossible to
 * mistake for a fresh one.
 */
import type { Pool, PoolClient } from "pg";
import { Embed } from "../embed/embed";
import { fetchFile, getHeadSha, KB_BRANCH, KB_REPO, listMarkdown } from "./github";
import { parseKbDocument } from "./parse";

export type SyncResult = {
  status: "unchanged" | "synced";
  commitSha: string;
  changed: number;
  deleted: number;
  total: number;
};

type Db = Pool | PoolClient;

/** Files that are protocol/navigation, not knowledge worth retrieving. */
const SKIP = new Set([
  "README.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "LICENSE.md",
  "NOTICE.md",
  "log.md",
]);

export async function syncAccountingKb(
  db: Db,
  opts: { repo?: string; branch?: string; force?: boolean } = {},
): Promise<SyncResult> {
  const repo = opts.repo ?? KB_REPO;
  const branch = opts.branch ?? KB_BRANCH;

  const head = await getHeadSha(repo, branch);
  await db.query(
    `INSERT INTO kb_sync_state (repo, last_checked_at)
     VALUES ($1, now())
     ON CONFLICT (repo) DO UPDATE SET last_checked_at = now()`,
    [repo],
  );

  const state = await db.query(
    `SELECT commit_sha, document_count FROM kb_sync_state WHERE repo = $1`,
    [repo],
  );
  const indexed = state.rows[0]?.commit_sha as string | undefined;

  if (!opts.force && indexed === head) {
    return {
      status: "unchanged",
      commitSha: head,
      changed: 0,
      deleted: 0,
      total: state.rows[0]?.document_count ?? 0,
    };
  }

  try {
    const tree = (await listMarkdown(head, repo)).filter(
      (e) => !SKIP.has(e.path),
    );

    const known = await db.query(
      `SELECT path, content_sha FROM kb_documents`,
    );
    const knownSha = new Map<string, string>(
      known.rows.map((r) => [r.path as string, r.content_sha as string]),
    );

    const stale = tree.filter(
      (e) => opts.force || knownSha.get(e.path) !== e.sha,
    );

    const embedder = new Embed();
    for (const entry of stale) {
      const raw = await fetchFile(head, entry.path, repo);
      const doc = parseKbDocument(entry.path, raw);

      const upserted = await db.query(
        `INSERT INTO kb_documents
           (path, title, description, type, tags, aliases, confidence,
            verify_live, review_after, sources, content, content_sha,
            commit_sha, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
         ON CONFLICT (path) DO UPDATE SET
           title = EXCLUDED.title, description = EXCLUDED.description,
           type = EXCLUDED.type, tags = EXCLUDED.tags,
           aliases = EXCLUDED.aliases, confidence = EXCLUDED.confidence,
           verify_live = EXCLUDED.verify_live,
           review_after = EXCLUDED.review_after, sources = EXCLUDED.sources,
           content = EXCLUDED.content, content_sha = EXCLUDED.content_sha,
           commit_sha = EXCLUDED.commit_sha, updated_at = now()
         RETURNING id`,
        [
          doc.path,
          doc.title,
          doc.description,
          doc.type,
          doc.tags,
          doc.aliases,
          doc.confidence,
          doc.verifyLive,
          doc.reviewAfter,
          doc.sources,
          doc.content,
          entry.sha,
          head,
        ],
      );
      const documentId = upserted.rows[0].id as string;

      // Replace chunks wholesale: a page's sections shift as it is edited, so
      // matching old chunks to new ones would be guesswork.
      await db.query(`DELETE FROM kb_chunks WHERE document_id = $1`, [
        documentId,
      ]);
      if (doc.chunks.length === 0) continue;

      const { embeddings } = await embedder.embedMany(
        doc.chunks.map((c) => c.content),
      );
      for (const [i, chunk] of doc.chunks.entries()) {
        await db.query(
          `INSERT INTO kb_chunks (document_id, position, heading, content, embedding)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            documentId,
            chunk.position,
            chunk.heading,
            chunk.content,
            JSON.stringify(embeddings[i]),
          ],
        );
      }
    }

    const paths = tree.map((e) => e.path);
    const removed = await db.query(
      `DELETE FROM kb_documents WHERE NOT (path = ANY($1)) RETURNING path`,
      [paths],
    );

    await db.query(
      `UPDATE kb_sync_state
          SET commit_sha = $2, indexed_at = now(), document_count = $3,
              last_error = NULL
        WHERE repo = $1`,
      [repo, head, paths.length],
    );

    return {
      status: "synced",
      commitSha: head,
      changed: stale.length,
      deleted: removed.rowCount ?? 0,
      total: paths.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.query(
      `UPDATE kb_sync_state SET last_error = $2 WHERE repo = $1`,
      [repo, message],
    );
    throw error;
  }
}
