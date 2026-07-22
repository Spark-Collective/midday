/**
 * M7 acceptance: grouped financial statements. The income statement is
 * period-bounded and its result equals revenue minus costs; the balance
 * sheet is cumulative, balances via the unallocated-result line, and ties
 * to the trial balance. Overview groups sum to total costs.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Pool, type PoolClient } from "pg";
import { postEntry } from "../src/post.js";
import { getTrialBalance } from "../src/reports.js";
import { seedBelgianLedger } from "../src/seed.js";
import { getOverview, getStatement } from "../src/statement.js";
import { initTestDb, TEST_DB_URL } from "./helpers/setup.js";

const pool = new Pool({ connectionString: TEST_DB_URL });
let db: PoolClient;
let teamId: string;

beforeAll(async () => {
  db = await pool.connect();
  teamId = await initTestDb(db);
  await db.query("BEGIN");
  await seedBelgianLedger(db, { teamId, years: [2025, 2026] });
  await db.query("COMMIT");
  await db.query(
    `INSERT INTO gl_accounts (team_id, code, name, type) VALUES
       ($1, '550001', 'KBC', 'asset'),
       ($1, '611010', 'Computerbenodigdheden', 'expense')`,
    [teamId],
  );
  await db.query(
    `UPDATE journals SET bank_account_id = gen_random_uuid(),
            gl_account_id = (SELECT id FROM gl_accounts WHERE team_id = $1 AND code = '550001')
      WHERE team_id = $1 AND code = '500'`,
    [teamId],
  );
  // 2025: revenue 1000, cost 400 -> result 600
  await postEntry(db, {
    teamId,
    journalCode: "890",
    date: "2025-03-01",
    lines: [
      { accountCode: "550001", debit: 1000 },
      { systemKey: "sales_revenue", credit: 1000 },
    ],
  });
  await postEntry(db, {
    teamId,
    journalCode: "890",
    date: "2025-04-01",
    lines: [
      { accountCode: "611010", debit: 400 },
      { accountCode: "550001", credit: 400 },
    ],
  });
  // 2025 year-end processing: allocation to reserves must NOT zero the shown
  // result (Belgian layout shows the pre-allocation result).
  await db.query(
    `INSERT INTO gl_accounts (team_id, code, name, type) VALUES
       ($1, '693000', 'Over te dragen winst', 'expense')`,
    [teamId],
  );
  await postEntry(db, {
    teamId,
    journalCode: "890",
    date: "2025-12-31",
    lines: [
      { accountCode: "693000", debit: 600 },
      { systemKey: "retained_earnings", credit: 600 },
    ],
  });
  // 2026: revenue 500, cost 300 (one IT, one VAT-carrying) -> result 200
  await postEntry(db, {
    teamId,
    journalCode: "890",
    date: "2026-02-01",
    lines: [
      { accountCode: "550001", debit: 500 },
      { systemKey: "sales_revenue", credit: 500 },
    ],
  });
  await postEntry(db, {
    teamId,
    journalCode: "890",
    date: "2026-02-15",
    lines: [
      { accountCode: "611010", debit: 279 },
      { systemKey: "vat_deductible", debit: 21, taxBase: 100 },
      { accountCode: "550001", credit: 300 },
    ],
  });
});

afterAll(async () => {
  db?.release();
  await pool.end();
});

describe("statements (M7)", () => {
  test("income statement is period-bounded with a correct result per column", async () => {
    const s = await getStatement(db, {
      teamId,
      kind: "income",
      periods: [
        { from: "2026-01-01", to: "2026-12-31", label: "2026" },
        { from: "2025-01-01", to: "2025-12-31", label: "2025" },
      ],
    });
    const rev = s.sections.find((x) => x.key === "opbrengsten")!;
    const cost = s.sections.find((x) => x.key === "kosten")!;
    expect(rev.totals).toEqual([500, 1000]);
    expect(cost.totals).toEqual([279, 400]);
    expect(s.result).toEqual([221, 600]);
    // account rows carry codes and both columns
    expect(cost.rows.find((r) => r.code === "611010")?.values).toEqual([
      279, 400,
    ]);
  });

  test("balance sheet balances via the unallocated-result line and ties to the TB", async () => {
    const s = await getStatement(db, {
      teamId,
      kind: "balance",
      periods: [{ to: "2026-12-31", label: "2026" }],
    });
    let activa = 0;
    let passiva = 0;
    for (const sec of s.sections) {
      if (sec.direction === "debit") activa += sec.totals[0]!;
      else passiva += sec.totals[0]!;
    }
    expect(Math.round((activa - passiva) * 100)).toBe(0);
    const ev = s.sections.find((x) => x.key === "eigen_vermogen")!;
    const unalloc = ev.rows.find((r) => r.code === "—");
    // 2025's 600 was processed to reserves; only 2026's 221 is unallocated
    expect(unalloc?.values).toEqual([221]);
    const tb = await getTrialBalance(db, { teamId, to: "2026-12-31" });
    const bankTb = tb.find((r) => r.code === "550001")?.balance ?? 0;
    const liquide = s.sections.find((x) => x.key === "liquide")!;
    expect(liquide.totals[0]).toBe(bankTb);
  });

  test("overview: KPIs, cost groups, bank and VAT quarters", async () => {
    const o = await getOverview(db, {
      teamId,
      year: 2026,
      asOf: "2026-12-31",
    });
    expect(o.revenueYtd).toBe(500);
    expect(o.costsYtd).toBe(279);
    expect(o.resultYtd).toBe(221);
    expect(o.revenuePrevYtd).toBe(1000);
    expect(o.costGroups.reduce((s, g) => s + g.amount, 0)).toBe(279);
    expect(o.costGroups[0]?.label).toBe("IT & materiaal");
    expect(o.bank.find((b) => b.code === "550001")?.balance).toBe(800);
    expect(o.vatQuarters.find((q) => q.quarter === 1)?.deductible).toBe(21);
  });
});
