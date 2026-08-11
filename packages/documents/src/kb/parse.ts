/**
 * Turning a KB markdown file into a document + its chunks.
 *
 * The frontmatter is the point. `confidence`, `verify_live`, `review_after`
 * and `sources` are the author's own judgment about how far a page can be
 * trusted, and carrying them through to the tool result is what makes the
 * KB's rule ("read the KB for the method, fetch the live source for the
 * number") enforceable instead of aspirational.
 *
 * Chunking splits on `##` headings: these pages are short and already written
 * one idea per section. Each chunk is prefixed with its document title and
 * heading so a retrieved fragment still says what it is about, which matters
 * when the model sees the chunk without its page.
 */
import { load } from "js-yaml";

export type KbFrontmatter = {
  title?: string;
  description?: string;
  type?: string;
  tags?: string[];
  aliases?: string[];
  confidence?: string;
  verify_live?: boolean;
  review_after?: string;
  sources?: string[];
};

export type KbChunk = { position: number; heading: string | null; content: string };

export type ParsedKbDocument = {
  path: string;
  title: string;
  description: string | null;
  type: string | null;
  tags: string[];
  aliases: string[];
  confidence: string | null;
  verifyLive: boolean;
  reviewAfter: string | null;
  sources: string[];
  content: string;
  chunks: KbChunk[];
};

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** A date the yaml loader may hand back as a Date, a string, or nonsense. */
const asDate = (v: unknown): string | null => {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) {
    return v.slice(0, 10);
  }
  return null;
};

/** Fallback title: last path segment, "restaurant-and-meals" -> readable. */
function titleFromPath(path: string): string {
  const base = path.split("/").pop()?.replace(/\.md$/, "") ?? path;
  return base.replace(/[-_]/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function parseKbDocument(
  path: string,
  raw: string,
): ParsedKbDocument {
  const match = raw.match(FRONTMATTER);
  let fm: KbFrontmatter = {};
  let body = raw;

  if (match) {
    body = raw.slice(match[0].length);
    try {
      const loaded = load(match[1]!);
      if (loaded && typeof loaded === "object") fm = loaded as KbFrontmatter;
    } catch {
      // A page with broken frontmatter is still worth indexing for its prose;
      // it just loses its judgment fields, so it is treated as unverified.
      fm = {};
    }
  }

  const title = fm.title?.trim() || titleFromPath(path);

  return {
    path,
    title,
    description: fm.description?.trim() || null,
    type: fm.type?.trim() || null,
    tags: asStringArray(fm.tags),
    aliases: asStringArray(fm.aliases),
    confidence: fm.confidence?.trim() || null,
    verifyLive: fm.verify_live === true,
    reviewAfter: asDate(fm.review_after),
    sources: asStringArray(fm.sources),
    content: body.trim(),
    chunks: chunkMarkdown(title, body),
  };
}

/**
 * Navigation sections, not knowledge: "See also" is a list of [[wikilinks]]
 * that embeds close to everything in its neighbourhood and wins result slots
 * from pages that actually answer the question.
 */
const NAVIGATION_HEADING = /^(see also|zie ook|related|sources?|bronnen)$/i;

export function chunkMarkdown(title: string, body: string): KbChunk[] {
  const keep = (s: { heading: string | null; lines: string[] }) =>
    s.lines.some((l) => l.trim()) &&
    !(s.heading && NAVIGATION_HEADING.test(s.heading));

  const lines = body.split("\n");
  const sections: Array<{ heading: string | null; lines: string[] }> = [];
  let current: { heading: string | null; lines: string[] } = {
    heading: null,
    lines: [],
  };

  for (const line of lines) {
    const h = line.match(/^##\s+(.*)$/);
    if (h) {
      if (keep(current)) sections.push(current);
      current = { heading: h[1]!.trim(), lines: [] };
      continue;
    }
    // The H1 repeats the title; drop it rather than embed it twice.
    if (/^#\s+/.test(line)) continue;
    current.lines.push(line);
  }
  if (keep(current)) sections.push(current);

  return sections.map((s, i) => {
    const text = s.lines.join("\n").trim();
    const prefix = s.heading ? `${title} — ${s.heading}` : title;
    return {
      position: i,
      heading: s.heading,
      content: `${prefix}\n\n${text}`,
    };
  });
}

/**
 * Whether a page's figures must be re-verified before use: the author said
 * so, said they were unsure, or the page is past its own review date.
 */
export function mustVerify(
  doc: Pick<ParsedKbDocument, "verifyLive" | "confidence" | "reviewAfter">,
  today: string,
): boolean {
  if (doc.verifyLive) return true;
  if (doc.confidence === "medium" || doc.confidence === "low") return true;
  if (doc.reviewAfter && doc.reviewAfter < today) return true;
  return false;
}
