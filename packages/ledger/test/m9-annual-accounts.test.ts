/**
 * M9 acceptance: the micro-model rubrieken mapper. The balance sheet
 * balances (incl. the not-yet-processed result inside 14), the brutomarge
 * income statement reproduces the year result, resultaatverwerking follows
 * 693/790, and every Balanscentrale arithmetic control passes.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Pool, type PoolClient } from "pg";
import { getAnnualAccounts } from "../src/annual-accounts.js";
import { postEntry } from "../src/post.js";
import { seedBelgianLedger } from "../src/seed.js";
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
       ($1, '611010', 'Computerbenodigdheden', 'expense'),
       ($1, '630200', 'Afschrijvingen MVA', 'expense'),
       ($1, '232000', 'Uitrusting', 'asset'),
       ($1, '111900', 'Inbreng buiten kapitaal', 'equity'),
       ($1, '693000', 'Over te dragen winst', 'expense'),
       ($1, '790000', 'Overgedragen winst vorig boekjaar', 'income')
     ON CONFLICT (team_id, code) DO NOTHING`,
    [teamId],
  );

  // 2025: inbreng 5000, revenue 3000, diensten 1000, afschrijving 200 on a
  // 232000 asset of 1000 -> result 1800, fully processed to 14.
  await postEntry(db, {
    teamId,
    journalCode: "890",
    date: "2025-01-05",
    lines: [
      { accountCode: "550001", debit: 5000 },
      { accountCode: "111900", credit: 5000 },
    ],
  });
  await postEntry(db, {
    teamId,
    journalCode: "890",
    date: "2025-03-01",
    lines: [
      { accountCode: "550001", debit: 3000 },
      { systemKey: "sales_revenue", credit: 3000 },
    ],
  });
  await postEntry(db, {
    teamId,
    journalCode: "890",
    date: "2025-04-01",
    lines: [
      { accountCode: "611010", debit: 1000 },
      { accountCode: "550001", credit: 1000 },
    ],
  });
  await postEntry(db, {
    teamId,
    journalCode: "890",
    date: "2025-06-01",
    lines: [
      { accountCode: "232000", debit: 1000 },
      { accountCode: "550001", credit: 1000 },
    ],
  });
  await postEntry(db, {
    teamId,
    journalCode: "890",
    date: "2025-12-31",
    lines: [
      { accountCode: "630200", debit: 200 },
      { accountCode: "232000", credit: 200 },
    ],
  });
  await postEntry(db, {
    teamId,
    journalCode: "890",
    date: "2025-12-31",
    lines: [
      { accountCode: "693000", debit: 1800 },
      { systemKey: "retained_earnings", credit: 1800 },
    ],
  });

  // 2026 (open year, NOT processed): revenue 500 cost 300 -> result 200.
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
    date: "2026-03-01",
    lines: [
      { accountCode: "611010", debit: 300 },
      { accountCode: "550001", credit: 300 },
    ],
  });
});

afterAll(async () => {
  db?.release();
  await pool.end();
});

const val = (list: Array<{ code: string; values: number[] }>, code: string) =>
  list.find((x) => x.code === code)?.values[0];

describe("annual accounts (M9)", () => {
  test("processed year 2025: balans, brutomarge and verwerking tie out", async () => {
    const aa = await getAnnualAccounts(db, { teamId, year: 2025 });
    expect(val(aa.balans.activa, "22/27")).toBe(800); // 1000 - 200
    expect(val(aa.balans.activa, "54/58")).toBe(6000); // 5000+3000-1000-1000
    expect(val(aa.balans.activa, "20/58")).toBe(6800); // 6000 + 800 MVA
    expect(val(aa.balans.passiva, "10/11")).toBe(5000);
    expect(val(aa.balans.passiva, "14")).toBe(1800); // processed, no plug
    expect(val(aa.balans.passiva, "10/49")).toBe(6800);
    expect(val(aa.resultatenrekening, "9900")).toBe(2000); // 3000 - 1000
    expect(val(aa.resultatenrekening, "630")).toBe(200);
    expect(val(aa.resultatenrekening, "9901")).toBe(1800);
    expect(val(aa.resultatenrekening, "9904")).toBe(1800);
    expect(val(aa.resultaatverwerking, "9905")).toBe(1800);
    expect(val(aa.resultaatverwerking, "14P")).toBe(1800);
    expect(aa.checks.every((c) => c.ok)).toBe(true);
  });

  test("open year 2026: unprocessed result plugs into 14 and the sheet balances", async () => {
    const aa = await getAnnualAccounts(db, {
      teamId,
      year: 2026,
      compareYear: 2025,
    });
    expect(val(aa.resultatenrekening, "9904")).toBe(200);
    expect(val(aa.balans.passiva, "14")).toBe(2000); // 1800 processed + 200 open
    expect(val(aa.balans.activa, "20/58")).toBe(
      val(aa.balans.passiva, "10/49"),
    );
    // comparative column present and consistent
    expect(aa.years).toEqual([2026, 2025]);
    expect(aa.resultatenrekening.find((x) => x.code === "9904")?.values[1]).toBe(1800);
    expect(aa.checks.every((c) => c.ok)).toBe(true);
  });
});
