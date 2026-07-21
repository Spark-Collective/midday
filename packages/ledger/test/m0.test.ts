/**
 * M0 acceptance tests, run against REAL Postgres (never mocks — the invariants
 * under test live in the database). Applies the 0012_accounting_core.sql
 * migration to a scratch database and verifies:
 *   - a balanced manual entry posts (engine path)
 *   - an unbalanced entry is rejected BY THE DB (bypassing the engine)
 *   - posted lines/entries are immutable (UPDATE/DELETE rejected)
 *   - double-posting the same source document is blocked (partial unique)
 *   - posting into a closed period is rejected
 *   - account-currency locks and group-account bans hold
 *   - the Belgian seed populates journals/periods/accounts/tax codes
 *
 * Needs: TEST_DATABASE_URL (or postgres://postgres:postgres@localhost:5433/midday_test).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Pool, type PoolClient } from "pg";
import { LedgerError, postEntry } from "../src/post.js";
import { seedBelgianLedger } from "../src/seed.js";
import { expectError, initTestDb, TEST_DB_URL } from "./helpers/setup.js";

const pool = new Pool({ connectionString: TEST_DB_URL });
let db: PoolClient;
let teamId: string;

beforeAll(async () => {
  db = await pool.connect();
  teamId = await initTestDb(db);
  await db.query("BEGIN");
  await seedBelgianLedger(db, { teamId, years: [2025, 2026] });
  await db.query("COMMIT");
});

afterAll(async () => {
  db?.release();
  await pool.end();
});

describe("seed", () => {
  test("populates journals, periods, system accounts, tax codes", async () => {
    const j = await db.query(
      `SELECT COUNT(*)::int AS n FROM journals WHERE team_id = $1`,
      [teamId],
    );
    expect(j.rows[0].n).toBe(6);
    const p = await db.query(
      `SELECT COUNT(*)::int AS n FROM fiscal_periods WHERE team_id = $1`,
      [teamId],
    );
    expect(p.rows[0].n).toBe(24);
    const a = await db.query(
      `SELECT COUNT(*)::int AS n FROM gl_accounts WHERE team_id = $1 AND system_key IS NOT NULL`,
      [teamId],
    );
    expect(a.rows[0].n).toBe(20);
    const t = await db.query(
      `SELECT COUNT(*)::int AS n, BOOL_AND(verified) AS all_verified FROM tax_codes WHERE team_id = $1`,
      [teamId],
    );
    expect(t.rows[0].n).toBe(8);
    expect(t.rows[0].all_verified).toBe(true); // grid mappings KB-verified (M3)
  });

  test("is idempotent", async () => {
    await db.query("BEGIN");
    const second = await seedBelgianLedger(db, { teamId, years: [2025, 2026] });
    await db.query("COMMIT");
    expect(second.journals).toBe(0);
    expect(second.periods).toBe(0);
    expect(second.taxCodes).toBe(0);
  });
});

describe("posting (engine path)", () => {
  test("a balanced manual entry posts with a gapless number", async () => {
    const res = await postEntry(db, {
      teamId,
      journalCode: "800",
      date: "2025-06-15",
      narration: "M0 acceptance: test entry",
      lines: [
        {
          systemKey: "trade_debtors",
          debit: 121,
          partyType: "customer",
          partyId: teamId,
        },
        { accountCode: "754000", credit: 121 },
      ],
    });
    expect(res.entryNumber).toBe("800-00001");
    const check = await db.query(
      `SELECT status, entry_number, posted_at FROM journal_entries WHERE id = $1`,
      [res.entryId],
    );
    expect(check.rows[0].status).toBe("posted");
    expect(check.rows[0].posted_at).not.toBeNull();
  });

  test("sequence increments per journal", async () => {
    const res = await postEntry(db, {
      teamId,
      journalCode: "800",
      date: "2025-06-16",
      lines: [
        { systemKey: "internal_transfers", debit: 50 },
        { systemKey: "trade_debtors", credit: 50 },
      ],
    });
    expect(res.entryNumber).toBe("800-00002");
  });

  test("multi-currency: USD line carries amountCurrency + fxRate", async () => {
    const res = await postEntry(db, {
      teamId,
      journalCode: "800",
      date: "2025-06-17",
      lines: [
        {
          systemKey: "trade_debtors",
          debit: 92,
          currency: "USD",
          amountCurrency: 100,
          fxRate: 0.92,
        },
        { systemKey: "fx_gain_realized", credit: 92 },
      ],
    });
    const lines = await db.query(
      `SELECT currency, amount_currency, fx_rate FROM ledger_lines
        WHERE entry_id = $1 ORDER BY debit DESC`,
      [res.entryId],
    );
    expect(lines.rows[0].currency).toBe("USD");
    expect(Number(lines.rows[0].amount_currency)).toBe(100);
    expect(Number(lines.rows[0].fx_rate)).toBe(0.92);
  });

  test("engine rejects an unbalanced entry before touching the DB", async () => {
    expect(
      postEntry(db, {
        teamId,
        journalCode: "800",
        date: "2025-06-15",
        lines: [
          { systemKey: "trade_debtors", debit: 100 },
          { accountCode: "754000", credit: 99.99 },
        ],
      }),
    ).rejects.toThrow(LedgerError);
  });

  test("double-posting the same source document is blocked (I5)", async () => {
    const sourceId = crypto.randomUUID();
    await postEntry(db, {
      teamId,
      journalCode: "800",
      date: "2025-06-18",
      sourceType: "manual",
      sourceId,
      lines: [
        { systemKey: "internal_transfers", debit: 10 },
        { systemKey: "trade_debtors", credit: 10 },
      ],
    });
    await expectError(
      postEntry(db, {
        teamId,
        journalCode: "800",
        date: "2025-06-18",
        sourceType: "manual",
        sourceId,
        lines: [
          { systemKey: "internal_transfers", debit: 10 },
          { systemKey: "trade_debtors", credit: 10 },
        ],
      }),
      /uq_journal_entries_source|duplicate key/,
    );
  });
});

describe("database invariants (bypassing the engine)", () => {
  /** Insert a draft entry + lines with raw SQL; returns entry id. */
  async function rawDraft(
    lines: Array<[string, number, number]>,
  ): Promise<string> {
    const period = await db.query(
      `SELECT id FROM fiscal_periods WHERE team_id = $1 AND year = 2025 AND month = 6`,
      [teamId],
    );
    const journal = await db.query(
      `SELECT id FROM journals WHERE team_id = $1 AND code = '890'`,
      [teamId],
    );
    const entry = await db.query(
      `INSERT INTO journal_entries (team_id, journal_id, date, period_id)
       VALUES ($1, $2, '2025-06-20', $3) RETURNING id`,
      [teamId, journal.rows[0].id, period.rows[0].id],
    );
    for (const [systemKey, debit, credit] of lines) {
      await db.query(
        `INSERT INTO ledger_lines (team_id, entry_id, account_id, debit, credit, currency, amount_currency)
         SELECT $1, $2, id, $3, $4, 'EUR', $5
           FROM gl_accounts WHERE team_id = $1 AND system_key = $6`,
        [
          teamId,
          entry.rows[0].id,
          debit,
          credit,
          debit > 0 ? debit : -credit,
          systemKey,
        ],
      );
    }
    return entry.rows[0].id;
  }

  test("I1: the DB rejects posting an unbalanced entry", async () => {
    const id = await rawDraft([
      ["trade_debtors", 100, 0],
      ["fx_gain_realized", 0, 90],
    ]);
    await expectError(
      db.query(`UPDATE journal_entries SET status = 'posted' WHERE id = $1`, [
        id,
      ]),
      /does not balance/,
    );
  });

  test("I1: the DB rejects posting with fewer than 2 lines", async () => {
    const id = await rawDraft([["trade_debtors", 100, 0]]);
    await expectError(
      db.query(`UPDATE journal_entries SET status = 'posted' WHERE id = $1`, [
        id,
      ]),
      /at least 2 lines/,
    );
  });

  test("I2: posted lines reject UPDATE and DELETE; entry rejects edits", async () => {
    const posted = await postEntry(db, {
      teamId,
      journalCode: "890",
      date: "2025-06-21",
      lines: [
        { systemKey: "trade_debtors", debit: 60.5 },
        { systemKey: "fx_gain_realized", credit: 60.5 },
      ],
    });
    await expectError(
      db.query(
        `UPDATE ledger_lines SET debit = 999 WHERE entry_id = $1 AND debit > 0`,
        [posted.entryId],
      ),
      /immutable/,
    );
    await expectError(
      db.query(`DELETE FROM ledger_lines WHERE entry_id = $1`, [
        posted.entryId,
      ]),
      /immutable/,
    );
    await expectError(
      db.query(
        `UPDATE journal_entries SET narration = 'tamper' WHERE id = $1`,
        [posted.entryId],
      ),
      /immutable/,
    );
    await expectError(
      db.query(`DELETE FROM journal_entries WHERE id = $1`, [posted.entryId]),
      /only draft entries/,
    );
    // The one legal transition: posted -> reversed, nothing else changed.
    await db.query(
      `UPDATE journal_entries SET status = 'reversed' WHERE id = $1`,
      [posted.entryId],
    );
    const after = await db.query(
      `SELECT status FROM journal_entries WHERE id = $1`,
      [posted.entryId],
    );
    expect(after.rows[0].status).toBe("reversed");
  });

  test("I2: cannot sneak lines into a posted entry", async () => {
    const posted = await postEntry(db, {
      teamId,
      journalCode: "890",
      date: "2025-06-22",
      lines: [
        { systemKey: "trade_debtors", debit: 10 },
        { systemKey: "fx_gain_realized", credit: 10 },
      ],
    });
    await expectError(
      db.query(
        `INSERT INTO ledger_lines (team_id, entry_id, account_id, debit, credit, currency, amount_currency)
         SELECT $1, $2, id, 5, 0, 'EUR', 5 FROM gl_accounts
          WHERE team_id = $1 AND system_key = 'trade_debtors'`,
        [teamId, posted.entryId],
      ),
      /cannot add lines to a posted entry/,
    );
  });

  test("I3: posting into a closed period is rejected", async () => {
    await db.query(
      `UPDATE fiscal_periods SET status = 'closed'
        WHERE team_id = $1 AND year = 2025 AND month = 3`,
      [teamId],
    );
    await expectError(
      postEntry(db, {
        teamId,
        journalCode: "800",
        date: "2025-03-10",
        lines: [
          { systemKey: "internal_transfers", debit: 1 },
          { systemKey: "trade_debtors", credit: 1 },
        ],
      }),
      /closed period/,
    );
  });

  test("I4: account-currency lock", async () => {
    await db.query(
      `INSERT INTO gl_accounts (team_id, code, name, type, currency)
       VALUES ($1, '550001', 'KBC zichtrekening', 'asset', 'EUR')`,
      [teamId],
    );
    await expectError(
      postEntry(db, {
        teamId,
        journalCode: "500",
        date: "2025-06-23",
        lines: [
          {
            accountCode: "550001",
            debit: 92,
            currency: "USD",
            amountCurrency: 100,
            fxRate: 0.92,
          },
          { systemKey: "fx_gain_realized", credit: 92 },
        ],
      }),
      /only accepts EUR/,
    );
  });

  test("I6: no postings to group accounts", async () => {
    await db.query(
      `INSERT INTO gl_accounts (team_id, code, name, type, is_group)
       VALUES ($1, '610000', 'Diensten en diverse goederen', 'expense', true)`,
      [teamId],
    );
    await expectError(
      postEntry(db, {
        teamId,
        journalCode: "800",
        date: "2025-06-24",
        lines: [
          { accountCode: "610000", debit: 20 },
          { systemKey: "trade_debtors", credit: 20 },
        ],
      }),
      /group account/,
    );
  });

  test("check constraint: a line cannot carry both sides", async () => {
    const period = await db.query(
      `SELECT id FROM fiscal_periods WHERE team_id = $1 AND year = 2025 AND month = 6`,
      [teamId],
    );
    const journal = await db.query(
      `SELECT id FROM journals WHERE team_id = $1 AND code = '800'`,
      [teamId],
    );
    const entry = await db.query(
      `INSERT INTO journal_entries (team_id, journal_id, date, period_id)
       VALUES ($1, $2, '2025-06-25', $3) RETURNING id`,
      [teamId, journal.rows[0].id, period.rows[0].id],
    );
    await expectError(
      db.query(
        `INSERT INTO ledger_lines (team_id, entry_id, account_id, debit, credit, currency, amount_currency)
         SELECT $1, $2, id, 10, 10, 'EUR', 10 FROM gl_accounts
          WHERE team_id = $1 AND system_key = 'trade_debtors'`,
        [teamId, entry.rows[0].id],
      ),
      /ledger_lines_one_side/,
    );
  });

  test("exchange_rates precision fix (F1) holds a real FX rate", async () => {
    await db.query(
      `INSERT INTO exchange_rates (base, rate, target) VALUES ('EUR', 0.9234567891, 'USD')`,
    );
    const res = await db.query(
      `SELECT rate FROM exchange_rates WHERE base = 'EUR' AND target = 'USD'`,
    );
    expect(Number(res.rows[0].rate)).toBe(0.9234567891);
  });
});
