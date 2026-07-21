/**
 * M4 acceptance: the report reads — date-bounded trial balance, general ledger,
 * and open items with pairwise residuals (a partially paid invoice shows its
 * exact remainder).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Pool, type PoolClient } from "pg";
import { postEntry } from "../src/post.js";
import { reconcile } from "../src/reconcile.js";
import {
  getGeneralLedger,
  getOpenItems,
  getTrialBalance,
} from "../src/reports.js";
import { seedBelgianLedger } from "../src/seed.js";
import { initTestDb, TEST_DB_URL } from "./helpers/setup.js";

const pool = new Pool({ connectionString: TEST_DB_URL });
let db: PoolClient;
let teamId: string;

async function line(entryId: string, code: string, side: "debit" | "credit") {
  const r = await db.query(
    `SELECT ll.id FROM ledger_lines ll JOIN gl_accounts a ON a.id = ll.account_id
      WHERE ll.entry_id = $1 AND a.code = $2 AND ll.${side} > 0`,
    [entryId, code],
  );
  return r.rows[0].id;
}

beforeAll(async () => {
  db = await pool.connect();
  teamId = await initTestDb(db);
  await db.query("BEGIN");
  await seedBelgianLedger(db, { teamId, years: [2025, 2026] });
  await db.query("COMMIT");
  await db.query(
    `INSERT INTO gl_accounts (team_id, code, name, type) VALUES ($1, '550001', 'KBC', 'asset')`,
    [teamId],
  );
  // invoice 121 (June), partial payment 50 (July)
  const inv = await postEntry(db, {
    teamId,
    journalCode: "890",
    date: "2025-06-10",
    lines: [
      { accountCode: "400000", debit: 121, description: "Invoice 2025-0042" },
      { systemKey: "sales_revenue", credit: 121 },
    ],
  });
  const pay = await postEntry(db, {
    teamId,
    journalCode: "890",
    date: "2025-07-05",
    lines: [
      { accountCode: "550001", debit: 50 },
      { accountCode: "400000", credit: 50 },
    ],
  });
  await reconcile(db, {
    teamId,
    lineIds: [
      await line(inv.entryId, "400000", "debit"),
      await line(pay.entryId, "400000", "credit"),
    ],
  });
});

afterAll(async () => {
  db?.release();
  await pool.end();
});

describe("reports (M4)", () => {
  test("trial balance is date-bounded", async () => {
    const june = await getTrialBalance(db, { teamId, to: "2025-06-30" });
    const debtorsJune = june.find((r) => r.code === "400000");
    expect(debtorsJune?.balance).toBe(121);
    const all = await getTrialBalance(db, { teamId });
    const debtorsAll = all.find((r) => r.code === "400000");
    expect(debtorsAll?.balance).toBe(71);
    // zero-sum both ways
    expect(all.reduce((s, r) => s + r.balance, 0)).toBeCloseTo(0, 2);
  });

  test("general ledger filters by account and date", async () => {
    const rows = await getGeneralLedger(db, {
      teamId,
      accountCode: "400000",
      from: "2025-07-01",
      to: "2025-07-31",
    });
    expect(rows.length).toBe(1);
    expect(rows[0]?.credit).toBe(50);
    expect(rows[0]?.journalCode).toBe("890");
  });

  test("open items carry the pairwise residual (121 - 50 = 71)", async () => {
    const items = await getOpenItems(db, { teamId });
    expect(items.length).toBe(1); // the payment line is fully allocated -> gone
    expect(items[0]?.accountCode).toBe("400000");
    expect(items[0]?.residual).toBe(71);
    expect(items[0]?.description).toContain("2025-0042");
  });
});
