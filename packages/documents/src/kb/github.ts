/**
 * Fetching the accounting knowledge graph from GitHub.
 *
 * The repo is public, so no token, no rate-limit budget to manage beyond the
 * unauthenticated 60/hour: a no-op sync costs exactly ONE request (the head
 * commit sha), and a real sync costs one more (the recursive tree) plus one
 * raw fetch per CHANGED file.
 *
 * The trick that makes it cheap: the git tree API returns each file's blob
 * sha, which is a content hash. Comparing those against what we stored tells
 * us what changed before downloading anything. Raw file content comes from
 * raw.githubusercontent.com, which is not the API and not rate-limited the
 * same way.
 */
export const KB_REPO = "Spark-Collective/accounting-knowledge-graph";
export const KB_BRANCH = "main";

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";

const headers = {
  Accept: "application/vnd.github+json",
  "User-Agent": "midday-accounting-kb-sync",
};

export type KbTreeEntry = { path: string; sha: string };

async function githubJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(
      `GitHub ${res.status} ${res.statusText} for ${url}${
        res.status === 403 ? " (rate limited?)" : ""
      }`,
    );
  }
  return (await res.json()) as T;
}

/** The one request an unchanged sync makes. */
export async function getHeadSha(
  repo = KB_REPO,
  branch = KB_BRANCH,
): Promise<string> {
  const data = await githubJson<{ sha: string }>(
    `${API}/repos/${repo}/commits/${branch}`,
  );
  return data.sha;
}

/** Every markdown file in the repo at `sha`, with its blob sha. */
export async function listMarkdown(
  sha: string,
  repo = KB_REPO,
): Promise<KbTreeEntry[]> {
  const data = await githubJson<{
    tree: Array<{ path: string; type: string; sha: string }>;
    truncated?: boolean;
  }>(`${API}/repos/${repo}/git/trees/${sha}?recursive=1`);

  if (data.truncated) {
    // Silently indexing a partial KB would look like missing knowledge, not
    // a broken sync. Fail loudly instead.
    throw new Error(
      "GitHub truncated the tree listing; the KB has outgrown a single tree request",
    );
  }

  return data.tree
    .filter((e) => e.type === "blob" && e.path.endsWith(".md"))
    .map((e) => ({ path: e.path, sha: e.sha }));
}

export async function fetchFile(
  sha: string,
  path: string,
  repo = KB_REPO,
): Promise<string> {
  const res = await fetch(`${RAW}/${repo}/${sha}/${path}`, {
    headers: { "User-Agent": headers["User-Agent"] },
  });
  if (!res.ok) {
    throw new Error(`raw fetch ${res.status} for ${path}`);
  }
  return res.text();
}
