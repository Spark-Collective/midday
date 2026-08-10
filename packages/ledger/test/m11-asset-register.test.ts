/**
 * M11 acceptance: the asset register.
 *
 * The reconciliation is the reason this view is worth having, so the tests
 * insist it can go RED: a depreciation entry posted outside the register must
 * be caught, otherwise the check is decoration.
 *
 * Also pins the two data-shape facts the module is built on: lines exist only
 * once posted (so the forward schedule is computed), and `amount` is a basis
 * that may be an opening NBV rather than historical cost.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Pool, type PoolClient } from "pg";
import { getAssetRegister } from "../src/assets.js";
import { postEntry } from "../src/post.js";
import { seedBelgianLedger } from "../src/seed.js";
import { initTestDb, TEST_DB_URL } from "./helpers/setup.js";

const pool = new Pool({ connectionString: TEST_DB_URL });
let db: PoolClient;
let teamId: string;
let assetAcc: string;
let accumAcc: string;
let chargeAcc: string;

/** Post one month of depreciation the way the engine does, and record it. */
async function depreciate(amortId: string, ym: [number, number], amount: number) {
  const entry = await postEntry(db, {
    teamId,
    journalCode: "890",
    date: `${ym[0]}-${String(ym[1]).padStart(2, "0")}-28`,
    narration: "depreciation",
    lines: [
      { accountCode: "630200", debit: amount },
      { accountCode: "232009", credit: amount },
    ],
  });
  const p = await db.query(
    `SELECT id FROM fiscal_periods WHERE team_id = $1 AND year = $2 AND month = $3`,
    [teamId, ym[0], ym[1]],
  );
  await db.query(
    `INSERT INTO amortization_lines (team_id, amortization_id, period_id, amount, entry_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [teamId, amortId, p.rows[0].id, amount, entry.entryId],
  );
}

beforeAll(async () => {
  db = await pool.connect();
  teamId = await initTestDb(db);
  await db.query("BEGIN");
  await seedBelgianLedger(db, { teamId, years: [2026] });
  await db.query("COMMIT");
  await db.query(
    `INSERT INTO gl_accounts (team_id, code, name, type) VALUES
       ($1,'232000','Uitrusting','asset'),
       ($1,'232009','Uitrusting : Afschrijving','asset'),
       ($1,'630200','Afschrijvingen MVA','expense'),
       ($1,'550001','KBC','asset')
     ON CONFLICT (team_id, code) DO NOTHING`,
    [teamId],
  );
  const ids = await db.query(
    `SELECT code, id FROM gl_accounts WHERE team_id = $1 AND code IN ('232000','232009','630200')`,
    [teamId],
  );
  const by = new Map(ids.rows.map((r) => [r.code, r.id]));
  assetAcc = by.get("232000");
  accumAcc = by.get("232009");
  chargeAcc = by.get("630200");

  // Buy an asset for 1.200 and run it over 12 months at 100/month.
  await postEntry(db, {
    teamId,
    journalCode: "890",
    date: "2026-01-05",
    lines: [
      { accountCode: "232000", debit: 1200 },
      { accountCode: "550001", credit: 1200 },
    ],
  });
  const am = await db.query(
    `INSERT INTO amortizations
       (team_id, kind, name, charge_account_id, balance_account_id, asset_account_id,
        source_ref, start_date, months, amount, residual_value, status)
     VALUES ($1,'asset','Test laptop',$2,$3,$4,'600/TEST','2026-01-01',12,1200,0,'active')
     RETURNING id`,
    [teamId, chargeAcc, accumAcc, assetAcc],
  );
  // Three months posted; the other nine do not exist as rows yet.
  for (const m of [1, 2, 3]) await depreciate(am.rows[0].id, [2026, m], 100);
});

afterAll(async () => {
  db?.release();
  await pool.end();
});

describe("asset register (M11)", () => {
  test("per-asset figures come from the posted lines", async () => {
    const r = await getAssetRegister(db, { teamId, asOf: "2026-03-31" });
    expect(r.assets).toHaveLength(1);
    const a = r.assets[0]!;
    expect(a.basis).toBe(1200);
    expect(a.depreciated).toBe(300);
    expect(a.netBookValue).toBe(900);
    expect(a.monthlyCharge).toBe(100);
    expect(a.postedMonths).toBe(3);
    expect(a.remainingMonths).toBe(9);
    expect(a.lastPostedPeriod).toBe("2026-03");
  });

  test("register NBV equals the ledger, and says which accounts it compared", async () => {
    const r = await getAssetRegister(db, { teamId, asOf: "2026-03-31" });
    // 1.200 gross - 300 accumulated = 900 in the books
    expect(r.reconciliation.ledgerNbv).toBe(900);
    expect(r.reconciliation.registerNbv).toBe(900);
    expect(r.reconciliation.difference).toBe(0);
    expect(r.reconciliation.ok).toBe(true);
    expect(r.reconciliation.accounts).toEqual(["232000", "232009"]);
  });

  test("the forward schedule is computed, since unposted lines do not exist", async () => {
    const r = await getAssetRegister(db, { teamId, asOf: "2026-03-31" });
    const m = (mm: string) => r.schedule.find((s) => s.month === mm)!;
    expect(m("2026-01").posted).toBe(100);
    expect(m("2026-03").posted).toBe(100);
    expect(m("2026-04").posted).toBe(0);
    expect(m("2026-04").scheduled).toBe(100);
    expect(m("2026-12").scheduled).toBe(100);
    // Apr..Dec is nine months at 100, which is exactly the remaining NBV.
    const scheduled = r.schedule.reduce((s, x) => s + x.scheduled, 0);
    expect(Math.round(scheduled * 100) / 100).toBe(900);
  });

  test("a month that is due but unposted is owed, not skipped", async () => {
    // Three months posted (Jan..Mar). Looking from June, April and May are
    // overdue: the engine posts on the 1st for the previous month, so a gap
    // must surface as scheduled rather than vanish because it sits in the past.
    const r = await getAssetRegister(db, { teamId, asOf: "2026-06-15" });
    const m = (mm: string) => r.schedule.find((s) => s.month === mm)!;
    expect(m("2026-04").posted).toBe(0);
    expect(m("2026-04").scheduled).toBe(100);
    expect(m("2026-05").scheduled).toBe(100);
    expect(m("2026-06").scheduled).toBe(100);
    const scheduled = r.schedule.reduce((s, x) => s + x.scheduled, 0);
    expect(Math.round(scheduled * 100) / 100).toBe(900);
  });

  test("gross and accumulated stay silent until every asset has its history", async () => {
    const r = await getAssetRegister(db, { teamId, asOf: "2026-03-31" });
    // Nothing backfilled yet: claiming a gross figure would be claiming a
    // number we do not have.
    expect(r.reconciliation.gross).toBeNull();
    expect(r.reconciliation.accumulated).toBeNull();
    expect(r.assets[0]!.acquisitionValue).toBeNull();
  });

  test("once backfilled, gross and accumulated reconcile too", async () => {
    // The asset cost 1.500 and had 300 depreciated before the register began,
    // so the opening basis of 1.200 is what the schedule runs on. Book that
    // prior history into the ledger the way a history import would.
    await postEntry(db, {
      teamId,
      journalCode: "890",
      date: "2026-01-01",
      narration: "prior cost and depreciation",
      lines: [
        { accountCode: "232000", debit: 300 },
        { accountCode: "232009", credit: 300 },
      ],
    });
    await db.query(
      `UPDATE amortizations
          SET acquisition_value = 1500, accumulated_at_start = 300
        WHERE team_id = $1`,
      [teamId],
    );

    const r = await getAssetRegister(db, { teamId, asOf: "2026-03-31" });
    const a = r.assets[0]!;
    expect(a.acquisitionValue).toBe(1500);
    expect(a.accumulatedAtStart).toBe(300);
    // 300 before the register + 300 posted since
    expect(a.accumulatedTotal).toBe(600);
    expect(a.basis).toBe(1200);

    const rec = r.reconciliation;
    expect(rec.gross).not.toBeNull();
    expect(rec.gross!.register).toBe(1500);
    expect(rec.gross!.ledger).toBe(1500);
    expect(rec.gross!.ok).toBe(true);
    expect(rec.accumulated!.register).toBe(600);
    expect(rec.accumulated!.ledger).toBe(600);
    expect(rec.accumulated!.ok).toBe(true);
    // and NBV still holds: 1500 - 600 = 900
    expect(rec.registerNbv).toBe(900);
    expect(rec.ok).toBe(true);
  });

  test("the DB refuses an acquisition history that does not add up", async () => {
    expect(
      db.query(
        `UPDATE amortizations SET acquisition_value = 9999, accumulated_at_start = 300
          WHERE team_id = $1`,
        [teamId],
      ),
    ).rejects.toThrow(/acquisition_identity/);
  });

  test("a depreciation posted OUTSIDE the register turns the check red", async () => {
    await postEntry(db, {
      teamId,
      journalCode: "890",
      date: "2026-03-30",
      narration: "manual depreciation, not in the register",
      lines: [
        { accountCode: "630200", debit: 50 },
        { accountCode: "232009", credit: 50 },
      ],
    });
    const r = await getAssetRegister(db, { teamId, asOf: "2026-03-31" });
    expect(r.reconciliation.ledgerNbv).toBe(850);
    expect(r.reconciliation.registerNbv).toBe(900);
    expect(r.reconciliation.difference).toBe(50);
    expect(r.reconciliation.ok).toBe(false);
  });
});
