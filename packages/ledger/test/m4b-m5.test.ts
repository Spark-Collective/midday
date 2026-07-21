/**
 * M4b + M5 acceptance on real Postgres: the amortization engine (assets AND
 * deferrals, rounding-corrected final month, disposal with gain/loss), FX
 * revaluation with its auto-reversing mirror, period close with completeness
 * checks, and the verworpen-uitgaven year view.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Pool, type PoolClient } from "pg";
import {
  disposeAsset,
  postAmortization,
  registerAmortization,
  scheduleAmountCents,
} from "../src/amortization.js";
import { closePeriod, revaluePeriod } from "../src/close.js";
import { postEntry } from "../src/post.js";
import { seedBelgianLedger } from "../src/seed.js";
import { expectError, initTestDb, TEST_DB_URL } from "./helpers/setup.js";

const pool = new Pool({ connectionString: TEST_DB_URL });
let db: PoolClient;
let teamId: string;

async function balance(code: string): Promise<number> {
  const r = await db.query(
    `SELECT COALESCE(SUM(ll.debit - ll.credit), 0) AS v
       FROM ledger_lines ll
       JOIN gl_accounts a ON a.id = ll.account_id
       JOIN journal_entries je ON je.id = ll.entry_id AND je.status = 'posted'
      WHERE a.team_id = $1 AND a.code = $2`,
    [teamId, code],
  );
  return Number(r.rows[0].v);
}

beforeAll(async () => {
  db = await pool.connect();
  teamId = await initTestDb(db);
  await db.query("BEGIN");
  await seedBelgianLedger(db, { teamId, years: [2025, 2026] });
  await db.query("COMMIT");
  // asset + bank accounts for the fixtures
  await db.query(
    `INSERT INTO gl_accounts (team_id, code, name, type) VALUES
       ($1, '232000', 'Uitrusting', 'asset'),
       ($1, '232009', 'Uitrusting : Afschrijving', 'asset'),
       ($1, '550001', 'KBC', 'asset'),
       ($1, '616200', 'Verzekeringen', 'expense')`,
    [teamId],
  );
  await db.query(
    `INSERT INTO gl_accounts (team_id, code, name, type, currency) VALUES
       ($1, '550002', 'USD account', 'asset', 'USD')`,
    [teamId],
  );
});

afterAll(async () => {
  db?.release();
  await pool.end();
});

describe("amortization engine (M4b)", () => {
  test("schedule maths: equal months, final month absorbs rounding", () => {
    const it = {
      start_date: "2025-01-15",
      months: 3,
      amount: 100,
      residual_value: 0,
    };
    expect(scheduleAmountCents(it, 2025, 1)).toBe(3333);
    expect(scheduleAmountCents(it, 2025, 2)).toBe(3333);
    expect(scheduleAmountCents(it, 2025, 3)).toBe(3334); // 33.33+33.33+33.34 = 100.00
    expect(scheduleAmountCents(it, 2024, 12)).toBe(0);
    expect(scheduleAmountCents(it, 2025, 4)).toBe(0);
  });

  test("asset + deferral post together as one entry per period", async () => {
    await registerAmortization(db, {
      teamId,
      kind: "asset",
      name: "MacBook",
      chargeAccountCode: "630200",
      balanceAccountCode: "232009",
      assetAccountCode: "232000",
      startDate: "2025-01-01",
      months: 36,
      amount: 3189.87,
    });
    await registerAmortization(db, {
      teamId,
      kind: "deferral",
      name: "QOVER verzekering",
      chargeAccountCode: "616200",
      balanceAccountCode: "490000",
      startDate: "2025-01-01",
      months: 12,
      amount: 1200,
    });
    // deferral setup: the paid premium moves into 490000 before it spreads
    await postEntry(db, {
      teamId,
      journalCode: "800",
      date: "2025-01-02",
      lines: [
        { accountCode: "490000", debit: 1200 },
        { accountCode: "550001", credit: 1200 },
      ],
    });
    const res = await postAmortization(db, { teamId, year: 2025, month: 1 });
    expect(res.items).toBe(2);
    // 3189.87/36 = 88.6075 -> 88.61 monthly; deferral 100.00
    expect(await balance("630200")).toBe(88.61);
    expect(await balance("232009")).toBe(-88.61);
    expect(await balance("616200")).toBe(100);
    expect(await balance("490000")).toBe(1100); // 1200 deferred - 100 spread
  });

  test("posting the same period again is a no-op (already recorded)", async () => {
    const res = await postAmortization(db, { teamId, year: 2025, month: 1 });
    expect(res.items).toBe(0);
  });

  test("full run completes to the cent: 36 months = exactly 3189.87", async () => {
    for (let i = 1; i < 36; i++) {
      const y = 2025 + Math.floor(i / 12);
      const m = (i % 12) + 1;
      // periods beyond the seeded years
      await db.query(
        `INSERT INTO fiscal_periods (team_id, year, month) VALUES ($1, $2, $3)
         ON CONFLICT ON CONSTRAINT fiscal_periods_team_year_month_unique DO NOTHING`,
        [teamId, y, m],
      );
      await postAmortization(db, { teamId, year: y, month: m });
    }
    expect(await balance("232009")).toBe(-3189.87);
    expect(await balance("490000")).toBe(0); // deferral fully melted after 12 months
    const status = await db.query(
      `SELECT kind, status FROM amortizations WHERE team_id = $1 ORDER BY kind`,
      [teamId],
    );
    expect(status.rows.every((r) => r.status === "completed")).toBe(true);
  });

  test("disposal derecognises cost + accumulated and books the gain", async () => {
    // fresh asset: cost 1000, 10 months, 2 months posted -> accum 200
    const { amortizationId } = await registerAmortization(db, {
      teamId,
      kind: "asset",
      name: "Screen",
      chargeAccountCode: "630200",
      balanceAccountCode: "232009",
      assetAccountCode: "232000",
      startDate: "2026-01-01",
      months: 10,
      amount: 1000,
    });
    // book the acquisition so 232000 carries the cost
    await postEntry(db, {
      teamId,
      journalCode: "800",
      date: "2026-01-05",
      lines: [
        { accountCode: "232000", debit: 1000 },
        { accountCode: "550001", credit: 1000 },
      ],
    });
    await postAmortization(db, { teamId, year: 2026, month: 1 });
    await postAmortization(db, { teamId, year: 2026, month: 2 });

    const before232000 = await balance("232000");
    const res = await disposeAsset(db, {
      teamId,
      amortizationId,
      date: "2026-03-15",
      proceeds: 900,
      proceedsAccountCode: "550001",
    });
    expect(res.entryNumber).toBeDefined();
    // cost gone from 232000 (1000 credited)
    expect(await balance("232000")).toBe(before232000 - 1000);
    // gain: proceeds 900 + accum 200 - cost 1000 = 100 -> 763000
    expect(await balance("763000")).toBe(-100);
    await expectError(
      disposeAsset(db, { teamId, amortizationId, date: "2026-03-16" }),
      /already disposed/,
    );
  });
});

describe("FX revaluation (M5)", () => {
  test("revalues a currency-locked account and mirrors next period", async () => {
    // $5,000 booked at 0.92 -> EUR 4,600
    await postEntry(db, {
      teamId,
      journalCode: "800",
      date: "2026-03-10",
      lines: [
        {
          accountCode: "550002",
          debit: 4600,
          currency: "USD",
          amountCurrency: 5000,
          fxRate: 0.92,
        },
        { systemKey: "sales_revenue", credit: 4600 },
      ],
    });
    const res = await revaluePeriod(db, {
      teamId,
      year: 2026,
      month: 3,
      rates: { USD: 0.95 },
    });
    // closing value 4,750 -> +150 unrealized gain
    expect(res.revalued).toEqual([{ accountCode: "550002", difference: 150 }]);
    const march = await db.query(
      `SELECT COALESCE(SUM(ll.debit - ll.credit), 0) AS v FROM ledger_lines ll
         JOIN gl_accounts a ON a.id = ll.account_id
         JOIN journal_entries je ON je.id = ll.entry_id AND je.status = 'posted'
        WHERE a.team_id = $1 AND a.code = '755000' AND je.date <= '2026-03-31'`,
      [teamId],
    );
    expect(Number(march.rows[0].v)).toBe(-150); // credit on the unrealized-gain account
    // the mirror on 1 April flips it back
    const april = await db.query(
      `SELECT ll.debit, ll.credit FROM ledger_lines ll
         JOIN gl_accounts a ON a.id = ll.account_id
         JOIN journal_entries je ON je.id = ll.entry_id
        WHERE a.team_id = $1 AND a.code = '755000' AND je.date = '2026-04-01'`,
      [teamId],
    );
    expect(Number(april.rows[0].debit)).toBe(150);
    // both entries flagged
    const flagged = await db.query(
      `SELECT COUNT(*)::int AS n FROM journal_entries
        WHERE team_id = $1 AND is_revaluation`,
      [teamId],
    );
    expect(flagged.rows[0].n).toBe(2);
  });
});

describe("period close (M5)", () => {
  test("refuses while documents are unposted, then closes; I3 locks it", async () => {
    // an unposted finalized invoice in 2026-05
    await db.query(
      `INSERT INTO invoices (team_id, amount, vat, currency, issue_date, status)
       VALUES ($1, 121, 21, 'EUR', '2026-05-10T10:00:00Z', 'unpaid')`,
      [teamId],
    );
    const first = await closePeriod(db, { teamId, year: 2026, month: 5 });
    expect(first.closed).toBe(false);
    expect(first.issues.some((i) => i.includes("invoice"))).toBe(true);

    const forced = await closePeriod(db, {
      teamId,
      year: 2026,
      month: 5,
      force: true,
    });
    expect(forced.closed).toBe(true);
    // I3 now blocks posting into May 2026
    await expectError(
      postEntry(db, {
        teamId,
        journalCode: "800",
        date: "2026-05-20",
        lines: [
          { accountCode: "550001", debit: 1 },
          { systemKey: "sales_revenue", credit: 1 },
        ],
      }),
      /closed period/,
    );
  });

  test("quarter-end close carries the VAT-return reminder", async () => {
    const res = await closePeriod(db, { teamId, year: 2026, month: 6 });
    expect(res.closed).toBe(true);
    expect(res.issues.some((i) => i.includes("VAT return"))).toBe(true);
  });
});

describe("verworpen uitgaven view (M5)", () => {
  test("computes the year's add-back per category from vu_rates", async () => {
    await db.query(
      `INSERT INTO gl_accounts (team_id, code, name, type, vu_category)
       VALUES ($1, '612910', 'Restaurantkosten beperkt', 'expense', 'restaurant')`,
      [teamId],
    );
    await db.query(
      `INSERT INTO vu_rates (team_id, category, fiscal_year, deductible_pct)
       VALUES ($1, 'restaurant', 2026, 69)`,
      [teamId],
    );
    await postEntry(db, {
      teamId,
      journalCode: "800",
      date: "2026-02-10",
      lines: [
        { accountCode: "612910", debit: 1000 },
        { accountCode: "550001", credit: 1000 },
      ],
    });
    const vu = await db.query(
      `SELECT * FROM v_verworpen_uitgaven WHERE team_id = $1 AND fiscal_year = 2026`,
      [teamId],
    );
    expect(vu.rows.length).toBe(1);
    expect(vu.rows[0].vu_category).toBe("restaurant");
    expect(Number(vu.rows[0].expense_base)).toBe(1000);
    expect(Number(vu.rows[0].disallowed_amount)).toBe(310); // 31% of 1000
  });

  test("a category without a rate shows a NULL gap, never a silent 100%", async () => {
    await db.query(
      `INSERT INTO gl_accounts (team_id, code, name, type, vu_category)
       VALUES ($1, '612200', 'Cadeaus (beperkt)', 'expense', 'gifts')`,
      [teamId],
    );
    await postEntry(db, {
      teamId,
      journalCode: "800",
      date: "2026-02-11",
      lines: [
        { accountCode: "612200", debit: 50 },
        { accountCode: "550001", credit: 50 },
      ],
    });
    const vu = await db.query(
      `SELECT deductible_pct, disallowed_amount FROM v_verworpen_uitgaven
        WHERE team_id = $1 AND vu_category = 'gifts'`,
      [teamId],
    );
    expect(vu.rows[0].deductible_pct).toBeNull();
    expect(vu.rows[0].disallowed_amount).toBeNull();
  });
});
