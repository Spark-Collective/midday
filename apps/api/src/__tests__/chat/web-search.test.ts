/**
 * Gemini grounding emits one source entry per citation, so a single page
 * appears many times in one answer. Unfiltered, the model gets a wall of
 * duplicate links and cites them as if they were independent corroboration.
 */
import { describe, expect, test } from "bun:test";
import { dedupeSources } from "@api/chat/web-search";

describe("web_search sources", () => {
  test("the same page cited repeatedly collapses to one source", () => {
    const out = dedupeSources([
      { url: "https://financien.belgium.be/x", title: "FOD" },
      { url: "https://financien.belgium.be/x", title: "FOD" },
      { url: "https://vlaanderen.be/y", title: "Vlaanderen" },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      title: "FOD",
      url: "https://financien.belgium.be/x",
    });
  });

  test("a source without a title falls back to its url, entries without a url are dropped", () => {
    const out = dedupeSources([
      { url: "https://example.test/a" },
      { title: "no url here" },
      undefined as unknown as { url?: string },
    ]);
    expect(out).toEqual([
      { title: "https://example.test/a", url: "https://example.test/a" },
    ]);
  });

  test("no sources at all is empty, not a crash", () => {
    expect(dedupeSources(undefined)).toEqual([]);
  });
});
