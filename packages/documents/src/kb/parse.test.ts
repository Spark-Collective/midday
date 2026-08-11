/**
 * The parser's job is to carry the KB's judgment fields through intact. If
 * `verify_live` or a low confidence is dropped, a changeable figure reaches
 * the model dressed as settled fact — the exact failure the KB exists to
 * prevent. These fixtures are shaped like the real pages.
 */
import { describe, expect, test } from "bun:test";
import { chunkMarkdown, mustVerify, parseKbDocument } from "./parse";

const PAGE = `---
type: reference
title: Restaurant and meals
description: Restaurant ~69%, VAT not deductible.
tags: [deductible-costs, vat, belgium, verify-live]
sources: [https://financien.belgium.be/nl/ondernemingen]
confidence: medium
created: 2026-06-26
updated: 2026-06-26
verify_live: true
review_after: 2027-01-31
aliases: ["restaurantkosten", "maaltijden aftrekbaar"]
---

# Restaurant and meals

Intro line under the H1.

## Deductibility

Restaurant costs are ~69% deductible.

## VAT

VAT on restaurant costs is not deductible.
`;

describe("KB document parsing", () => {
  test("frontmatter judgment fields survive intact", () => {
    const doc = parseKbDocument(
      "concepts/deductible-costs/restaurant-and-meals.md",
      PAGE,
    );
    expect(doc.title).toBe("Restaurant and meals");
    expect(doc.confidence).toBe("medium");
    expect(doc.verifyLive).toBe(true);
    expect(doc.reviewAfter).toBe("2027-01-31");
    expect(doc.sources).toEqual(["https://financien.belgium.be/nl/ondernemingen"]);
    expect(doc.aliases).toEqual(["restaurantkosten", "maaltijden aftrekbaar"]);
    expect(doc.tags).toContain("deductible-costs");
    // The frontmatter block itself must not leak into the indexed content.
    expect(doc.content).not.toContain("verify_live");
  });

  test("chunks split on H2 and each names its page", () => {
    const doc = parseKbDocument("x.md", PAGE);
    expect(doc.chunks).toHaveLength(3); // intro + two sections
    expect(doc.chunks[1]!.heading).toBe("Deductibility");
    // An isolated chunk still says what it is about.
    expect(doc.chunks[1]!.content).toStartWith(
      "Restaurant and meals — Deductibility",
    );
    expect(doc.chunks[1]!.content).toContain("~69% deductible");
    // The H1 repeats the title; it should not be embedded twice.
    expect(doc.chunks[0]!.content).not.toContain("# Restaurant and meals");
  });

  test("a page with broken frontmatter is still indexed, as unverified", () => {
    const doc = parseKbDocument("concepts/vat/broken.md", "---\n: : :\n---\nBody text.");
    expect(doc.title).toBe("Broken");
    expect(doc.verifyLive).toBe(false);
    expect(doc.confidence).toBeNull();
    expect(doc.content).toContain("Body text");
  });

  test("a page with no frontmatter falls back to its filename", () => {
    const doc = parseKbDocument(
      "concepts/vat/vat-return-grilles.md",
      "# Whatever\n\nSome prose.",
    );
    expect(doc.title).toBe("Vat return grilles");
    expect(doc.chunks).toHaveLength(1);
  });

  test("navigation sections are not indexed as knowledge", () => {
    // "See also" is a wikilink list; it embeds close to everything nearby and
    // would take result slots from pages that answer the question.
    const chunks = chunkMarkdown(
      "T",
      "## Rule\n\nthe actual rule\n\n## See also\n\n- [[a]]\n- [[b]]\n",
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.heading).toBe("Rule");
  });

  test("empty sections are dropped rather than embedded as noise", () => {
    const chunks = chunkMarkdown("T", "## A\n\n\n## B\n\nreal content\n");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.heading).toBe("B");
  });
});

describe("verify-before-use rule", () => {
  const base = { verifyLive: false, confidence: "high", reviewAfter: null };

  test("verify_live forces verification", () => {
    expect(mustVerify({ ...base, verifyLive: true }, "2026-08-12")).toBe(true);
  });

  test("medium or low confidence forces verification", () => {
    expect(mustVerify({ ...base, confidence: "medium" }, "2026-08-12")).toBe(true);
    expect(mustVerify({ ...base, confidence: "low" }, "2026-08-12")).toBe(true);
  });

  test("a page past its own review date forces verification", () => {
    expect(mustVerify({ ...base, reviewAfter: "2026-01-31" }, "2026-08-12")).toBe(true);
    expect(mustVerify({ ...base, reviewAfter: "2027-01-31" }, "2026-08-12")).toBe(false);
  });

  test("a fresh, high-confidence, stable page does not", () => {
    expect(mustVerify({ ...base, reviewAfter: "2027-06-26" }, "2026-08-12")).toBe(false);
  });
});
