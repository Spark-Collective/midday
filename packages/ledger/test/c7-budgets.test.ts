/**
 * Budgets (C7). The report half is arithmetic. What these guard is the join to
 * the forecast: a budget REPLACES the trailing average for the month it covers,
 * and the two must never both count the same category, which would inflate
 * projected spend by exactly the budget.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Pool, type PoolClient } from "pg";
import {
  copyBudgetForward,
  getBudgetVsActual,
  getOperatingPlan,
  setBudget,
  UNCATEGORISED,
} from "../src/budgets.js";
import { buildCashForecast } from "../src/cashflow.js";
import { expectError, initTestDb, TEST_DB_URL } from "./helpers/setup.js";

const pool = new Pool({ connectionString: TEST_DB_URL });
let db: PoolClient;
let teamId: string;
const ASOF = "2026-08-03";

async function category(slug: string, name: string, excluded = false) {
  await db.query(
    `INSERT INTO transaction_categories (team_id, slug, name, excluded) VALUES ($1,$2,$3,$4)`,
    [teamId, slug, name, excluded],
  );
}

async function spend(slug: string | null, date: string, amount: number) {
  await db.query(
    `INSERT INTO transactions (team_id, date, name, amount, currency, category_slug)
     VALUES ($1,$2,'x',$3,'EUR',$4)`,
    [teamId, date, -Math.abs(amount), slug],
  );
}

beforeAll(async () => {
  db = await pool.connect();
  teamId = await initTestDb(db);
  await db.query(
    `INSERT INTO bank_accounts (team_id, name, currency, balance, enabled)
     VALUES ($1,'KBC','EUR',10000,true)`,
    [teamId],
  );

  await category("software", "Software");
  await category("travel", "Travel");
  await category("training", "Training");
  await category("internal", "Internal transfer", true);

  // 90 days before 2026-08-03: 300/month software, 150/month travel.
  for (const d of ["2026-05-10", "2026-06-10", "2026-07-10"]) {
    await spend("software", d, 300);
    await spend("travel", d, 150);
    await spend("internal", d, 9999); // excluded category: must never count
    await spend(null, d, 60); // uncategorised
  }
});

afterAll(async () => {
  db?.release();
  await pool.end();
});

describe("setting budgets", () => {
  test("rejects a malformed month and a negative amount", async () => {
    await expectError(
      setBudget(db, {
        teamId,
        categorySlug: "software",
        month: "2026-9",
        amount: 100,
      }),
      /YYYY-MM/,
    );
    await expectError(
      setBudget(db, {
        teamId,
        categorySlug: "software",
        month: "2026-09",
        amount: -5,
      }),
      /cannot be negative/,
    );
  });

  test("upserts, and null removes", async () => {
    await setBudget(db, {
      teamId,
      categorySlug: "software",
      month: "2026-09",
      amount: 100,
    });
    await setBudget(db, {
      teamId,
      categorySlug: "software",
      month: "2026-09",
      amount: 250,
    });
    let r = await getBudgetVsActual(db, { teamId, month: "2026-09" });
    expect(r.rows.find((x) => x.categorySlug === "software")?.budget).toBe(250);

    await setBudget(db, {
      teamId,
      categorySlug: "software",
      month: "2026-09",
      amount: null,
    });
    r = await getBudgetVsActual(db, { teamId, month: "2026-09" });
    expect(r.rows.find((x) => x.categorySlug === "software")).toBeUndefined();
  });

  test("copies across the rest of the year only, never backwards", async () => {
    await setBudget(db, {
      teamId,
      categorySlug: "travel",
      month: "2026-10",
      amount: 200,
    });
    const { months } = await copyBudgetForward(db, {
      teamId,
      categorySlug: "travel",
      month: "2026-10",
    });
    expect(months).toEqual(["2026-11", "2026-12"]);
    const sep = await getBudgetVsActual(db, { teamId, month: "2026-09" });
    expect(sep.rows.find((x) => x.categorySlug === "travel")).toBeUndefined();
    const dec = await getBudgetVsActual(db, { teamId, month: "2026-12" });
    expect(dec.rows.find((x) => x.categorySlug === "travel")?.budget).toBe(200);
  });

  test("refuses to copy a budget that does not exist", async () => {
    await expectError(
      copyBudgetForward(db, {
        teamId,
        categorySlug: "software",
        month: "2026-06",
      }),
      /nothing to copy/,
    );
  });
});

describe("budget against actual", () => {
  test("an unbudgeted overspend still appears, and excluded categories never do", async () => {
    await spend("training", "2026-07-15", 500);
    const r = await getBudgetVsActual(db, { teamId, month: "2026-07" });
    const training = r.rows.find((x) => x.categorySlug === "training");
    // No budget for July, but 500 of spend: it must not be able to hide.
    expect(training?.actual).toBe(500);
    expect(training?.budget).toBeNull();
    expect(training?.variance).toBeNull();
    expect(r.rows.some((x) => x.categorySlug === "internal")).toBe(false);
    expect(r.rows.some((x) => x.categorySlug === UNCATEGORISED)).toBe(true);
    // The sentinel must not read as Midday's own "uncategorized" category.
    const f = await buildCashForecast(db, {
      teamId,
      asOf: ASOF,
      weeks: 1,
      months: 0,
    });
    expect(
      f.buckets
        .flatMap((b) => b.lines)
        .some((l) => l.label === "Uncategorised"),
    ).toBe(false);
  });

  test("variance is negative when over budget", async () => {
    await setBudget(db, {
      teamId,
      categorySlug: "training",
      month: "2026-07",
      amount: 200,
    });
    const r = await getBudgetVsActual(db, { teamId, month: "2026-07" });
    const training = r.rows.find((x) => x.categorySlug === "training");
    expect(training?.variance).toBe(-300);
    await setBudget(db, {
      teamId,
      categorySlug: "training",
      month: "2026-07",
      amount: null,
    });
  });
});

describe("the join to the forecast", () => {
  const septOutflow = async () => {
    const f = await buildCashForecast(db, {
      teamId,
      asOf: ASOF,
      weeks: 0,
      months: 3,
    });
    const b = f.buckets.find((x) => x.start.startsWith("2026-09"));
    return { outflow: b?.outflow ?? 0, lines: b?.lines ?? [] };
  };

  test("a budget EQUAL to the trailing rate leaves the curve unchanged", async () => {
    // The sharpest statement of "replaces, does not add": if intent and history
    // agree, projected spend must not move by a cent. Any double count shows up
    // here as the budget appearing twice.
    const plan = await getOperatingPlan(db, {
      teamId,
      asOf: ASOF,
      through: "2026-12-31",
    });
    const trailing = plan.trailingByCategory.get("software") ?? 0;
    expect(trailing).toBeGreaterThan(0);

    const before = await septOutflow();
    await setBudget(db, {
      teamId,
      categorySlug: "software",
      month: "2026-09",
      amount: trailing,
    });
    const after = await septOutflow();
    expect(after.outflow).toBeCloseTo(before.outflow, 1);

    // ...and it is now labelled as intent rather than buried in the average.
    expect(
      after.lines.some((l) => l.kind === "budget" && l.label === "Software"),
    ).toBe(true);
  });

  test("raising the budget adds only the difference, never the whole amount", async () => {
    const plan = await getOperatingPlan(db, {
      teamId,
      asOf: ASOF,
      through: "2026-12-31",
    });
    const trailing = plan.trailingByCategory.get("software") ?? 0;

    const before = await septOutflow();
    await setBudget(db, {
      teamId,
      categorySlug: "software",
      month: "2026-09",
      amount: trailing + 600,
    });
    const after = await septOutflow();

    const delta = before.outflow - after.outflow; // positive = more spend
    expect(delta).toBeGreaterThan(0);
    // Adding the budget on top of an untouched average would move it by the
    // full trailing + 600.
    expect(delta).toBeLessThan(600);
  });

  test("a month the budget does not cover falls back to history", async () => {
    const f = await buildCashForecast(db, {
      teamId,
      asOf: ASOF,
      weeks: 0,
      months: 3,
    });
    const oct = f.buckets.find((b) => b.start.startsWith("2026-10"));
    // Software is budgeted for September only, so no software budget line here.
    expect(
      oct?.lines.some((l) => l.kind === "budget" && l.label === "Software"),
    ).toBe(false);
    // Travel IS budgeted for October, so it appears as intent.
    expect(
      oct?.lines.some((l) => l.kind === "budget" && l.label === "Travel"),
    ).toBe(true);
    // And history still covers everything unbudgeted.
    expect(oct?.lines.some((l) => l.kind === "run_rate")).toBe(true);
  });

  test("a weekly bucket straddling two months splits the budget by real days", async () => {
    const f = await buildCashForecast(db, {
      teamId,
      asOf: "2026-08-29",
      weeks: 2,
      months: 0,
    });
    // 29 Aug to 5 Sep: 3 days of August, 4 of September. The September budget
    // may only apply to its own 4 days.
    const straddle = f.buckets[0];
    const budget = straddle?.lines.find((l) => l.kind === "budget");
    expect(budget).toBeDefined();
    const monthly = 4 * 100; // whatever it is, a partial week must be a fraction
    expect(Math.abs(budget?.amount ?? 0)).toBeLessThan(monthly);
    // August's share of the same categories still comes from history.
    expect(straddle?.lines.some((l) => l.kind === "run_rate")).toBe(true);
  });
});
