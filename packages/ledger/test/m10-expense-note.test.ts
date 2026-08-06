/**
 * M10 acceptance: onkostennota posting. An expense note debits its cost
 * accounts and credits the director's R/C for the total, carries no VAT, is
 * idempotent, and is frozen once booked. The first case reproduces Spark's
 * real 2025-004 note (EUR 200 thuisladen Tesla) against the account the
 * accountant actually used.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Pool, type PoolClient } from "pg";
import { LedgerError } from "../src/post.js";
import { postExpenseNote } from "../src/post-expense-note.js";
import { seedBelgianLedger } from "../src/seed.js";
import { initTestDb, TEST_DB_URL } from "./helpers/setup.js";

const pool = new Pool({ connectionString: TEST_DB_URL });
let db: PoolClient;
let teamId: string;
let directorId: string;

async function makeNote(opts: {
  number: string;
  date: string;
  total: number;
  lines: Array<{ code: string; amount: number; description?: string }>;
  status?: string;
  director?: string | null;
}): Promise<string> {
  const seq = Number(opts.number.split("-")[1]);
  const res = await db.query(
    `INSERT INTO expense_notes
       (team_id, director_id, submitter_name, submitter_iban, year, seq,
        note_number, issue_date, total, status)
     VALUES ($1, $2, 'Jonas Boury', 'BE57 7380 2457 1435', $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      teamId,
      opts.director === undefined ? directorId : opts.director,
      Number(opts.date.slice(0, 4)),
      seq,
      opts.number,
      opts.date,
      opts.total,
      opts.status ?? "posted",
    ],
  );
  const id = res.rows[0].id;
  let pos = 0;
  for (const l of opts.lines) {
    await db.query(
      `INSERT INTO expense_note_lines
         (expense_note_id, team_id, position, description, gl_account_code, amount)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        id,
        teamId,
        pos++,
        l.description ?? "thuisladen tesla",
        l.code,
        l.amount,
      ],
    );
  }
  return id;
}

beforeAll(async () => {
  db = await pool.connect();
  teamId = await initTestDb(db);
  await db.query("BEGIN");
  await seedBelgianLedger(db, { teamId, years: [2025, 2026] });
  await db.query("COMMIT");
  await db.query(
    `INSERT INTO gl_accounts (team_id, code, name, type) VALUES
       ($1, '611901', 'Brandstof personenwagens elektriciteit', 'expense'),
       ($1, '612900', 'Onthaalkosten beperkt', 'expense'),
       ($1, '483000', 'R/C bedrijfsleider', 'liability')
     ON CONFLICT (team_id, code) DO NOTHING`,
    [teamId],
  );
  const rc = await db.query(
    `SELECT id FROM gl_accounts WHERE team_id = $1 AND code = '483000'`,
    [teamId],
  );
  const d = await db.query(
    `INSERT INTO directors (team_id, name, gl_account_id) VALUES ($1, 'Jonas Boury', $2) RETURNING id`,
    [teamId, rc.rows[0].id],
  );
  directorId = d.rows[0].id;
});

afterAll(async () => {
  db?.release();
  await pool.end();
});

describe("expense notes (M10)", () => {
  test("2025-004 reproduces the real booking: Dr 611901 200 / Cr R/C 200, no VAT", async () => {
    const id = await makeNote({
      number: "2025-004",
      date: "2025-12-31",
      total: 200,
      lines: [{ code: "611901", amount: 200 }],
    });
    const { entryId } = await postExpenseNote(db, {
      expenseNoteId: id,
      teamId,
    });

    const lines = await db.query(
      `SELECT a.code, ll.debit::float8 AS dr, ll.credit::float8 AS cr, ll.tax_code_id
         FROM ledger_lines ll JOIN gl_accounts a ON a.id = ll.account_id
        WHERE ll.entry_id = $1 ORDER BY ll.debit DESC`,
      [entryId],
    );
    expect(lines.rows).toHaveLength(2);
    expect(lines.rows[0]).toMatchObject({ code: "611901", dr: 200, cr: 0 });
    expect(lines.rows[1]).toMatchObject({ code: "483000", dr: 0, cr: 200 });
    // an onkostennota never carries deductible VAT
    expect(lines.rows.every((l) => l.tax_code_id === null)).toBe(true);

    const note = await db.query(
      `SELECT journal_entry_id FROM expense_notes WHERE id = $1`,
      [id],
    );
    expect(note.rows[0].journal_entry_id).toBe(entryId);
  });

  test("multi-line note splits across cost accounts and credits one R/C total", async () => {
    const id = await makeNote({
      number: "2026-001",
      date: "2026-03-31",
      total: 275.5,
      lines: [
        { code: "611901", amount: 200 },
        { code: "612900", amount: 75.5, description: "klantenlunch" },
      ],
    });
    const { entryId } = await postExpenseNote(db, {
      expenseNoteId: id,
      teamId,
    });
    const lines = await db.query(
      `SELECT a.code, ll.debit::float8 AS dr, ll.credit::float8 AS cr
         FROM ledger_lines ll JOIN gl_accounts a ON a.id = ll.account_id
        WHERE ll.entry_id = $1 ORDER BY ll.credit DESC, a.code`,
      [entryId],
    );
    expect(lines.rows[0]).toMatchObject({ code: "483000", cr: 275.5 });
    expect(lines.rows.filter((l) => l.dr > 0)).toHaveLength(2);
  });

  test("rejects: double post, drafts, bad totals, unknown accounts, no R/C", async () => {
    const posted = await makeNote({
      number: "2026-002",
      date: "2026-04-30",
      total: 50,
      lines: [{ code: "611901", amount: 50 }],
    });
    await postExpenseNote(db, { expenseNoteId: posted, teamId });
    expect(
      postExpenseNote(db, { expenseNoteId: posted, teamId }),
    ).rejects.toThrow(/already posted/);

    const draft = await makeNote({
      number: "2026-003",
      date: "2026-04-30",
      total: 10,
      lines: [{ code: "611901", amount: 10 }],
      status: "draft",
    });
    expect(
      postExpenseNote(db, { expenseNoteId: draft, teamId }),
    ).rejects.toThrow(/draft/);

    const mismatch = await makeNote({
      number: "2026-004",
      date: "2026-04-30",
      total: 100,
      lines: [{ code: "611901", amount: 90 }],
    });
    expect(
      postExpenseNote(db, { expenseNoteId: mismatch, teamId }),
    ).rejects.toThrow(/lines sum to/);

    const unknown = await makeNote({
      number: "2026-005",
      date: "2026-04-30",
      total: 25,
      lines: [{ code: "699999", amount: 25 }],
    });
    expect(
      postExpenseNote(db, { expenseNoteId: unknown, teamId }),
    ).rejects.toThrow(/unknown account/);

    const noRc = await makeNote({
      number: "2026-006",
      date: "2026-04-30",
      total: 25,
      lines: [{ code: "611901", amount: 25 }],
      director: null,
    });
    expect(
      postExpenseNote(db, { expenseNoteId: noRc, teamId }),
    ).rejects.toThrow(/R\/C account/);
  });

  test("a booked note is frozen: amount edits and deletes are refused", async () => {
    const id = await makeNote({
      number: "2026-007",
      date: "2026-05-31",
      total: 40,
      lines: [{ code: "611901", amount: 40 }],
    });
    await postExpenseNote(db, { expenseNoteId: id, teamId });

    expect(
      db.query(`UPDATE expense_notes SET total = 99 WHERE id = $1`, [id]),
    ).rejects.toThrow(/booked/);
    expect(
      db.query(`DELETE FROM expense_notes WHERE id = $1`, [id]),
    ).rejects.toThrow(/booked/);
    expect(
      db.query(
        `UPDATE expense_note_lines SET amount = 99 WHERE expense_note_id = $1`,
        [id],
      ),
    ).rejects.toThrow(/booked/);
    // status must stay writable (posted -> paid)
    await db.query(`UPDATE expense_notes SET status = 'paid' WHERE id = $1`, [
      id,
    ]);
  });
});
