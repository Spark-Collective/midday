/**
 * Regression: the ledger review counters shipped 297/297 once, because
 * `${transactions.id}` interpolated into a drizzle select projection renders
 * unqualified as `"id"`. Inside a correlated subquery Postgres then resolves
 * it to the INNER table's id (`je.source_id = je.id`), a never-true condition
 * that makes NOT EXISTS always true. No error, just a plausible wrong number
 * on the front page.
 *
 * The counters are only meaningful if the correlation reaches the OUTER
 * transaction, so that is what these assert.
 */
import { describe, expect, test } from "bun:test";
import { ledgerReviewStatsQuery } from "../queries/overview";

const rendered = () => {
  const q = ledgerReviewStatsQuery(
    "72f318f0-a561-44df-97b9-da40097bc31f",
    "2026-01-01",
  );
  // The chunks carry the SQL text; params are placeholders.
  return q.queryChunks
    .map((c) => (typeof c === "object" && "value" in c ? c.value : ""))
    .flat()
    .join("");
};

describe("ledger review stats SQL", () => {
  test("every subquery correlates to the outer transaction", () => {
    const sql = rendered();
    expect(sql).toContain("je.source_id = t.id");
    expect(sql).toContain("ta.transaction_id = t.id");
    expect(sql).toContain("i.transaction_id = t.id");
  });

  test("no unqualified id reference can bind to an inner table", () => {
    // `= "id"` or `= id` is exactly the shape that silently mis-resolved.
    expect(rendered()).not.toMatch(/=\s*"?id"?\b/);
  });

  test("scoped to the ledger era, posted only, transfers exempt from documents", () => {
    const sql = rendered();
    expect(sql).toContain("t.status = 'posted'");
    expect(sql).toContain("t.date >=");
    expect(sql).toContain("t.category_slug IS DISTINCT FROM 'transfer'");
  });
});
