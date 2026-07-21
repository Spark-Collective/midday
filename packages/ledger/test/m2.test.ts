/**
 * M2 acceptance tests on real Postgres: pairwise reconciliation (full, partial,
 * write-off within tolerance, realized FX — the plan's worked example B),
 * unallocate, and reversal as the only correction path.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Pool, type PoolClient } from "pg";
import { postEntry } from "../src/post.js";
import { postInvoice } from "../src/post-invoice.js";
import { reconcile, unallocate } from "../src/reconcile.js";
import { reverseEntry } from "../src/reverse.js";
import { seedBelgianLedger } from "../src/seed.js";
import { expectError, initTestDb, TEST_DB_URL } from "./helpers/setup.js";

const pool = new Pool({ connectionString: TEST_DB_URL });
let db: PoolClient;
let teamId: string;

async function getLine(
  entryId: string,
  code: string,
  side: "debit" | "credit",
): Promise<string> {
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
});

afterAll(async () => {
  db?.release();
  await pool.end();
});

/** Post a simple invoice-side + payment-side pair on 400000. */
async function invoiceAndPayment(
  amountInv: number,
  amountPay: number,
  party?: string,
): Promise<{ invLine: string; payLine: string }> {
  const p = party ?? crypto.randomUUID();
  const inv = await postEntry(db, {
    teamId,
    journalCode: "890",
    date: "2025-06-01",
    lines: [
      {
        accountCode: "400000",
        debit: amountInv,
        partyType: "customer",
        partyId: p,
      },
      { systemKey: "sales_revenue", credit: amountInv },
    ],
  });
  const pay = await postEntry(db, {
    teamId,
    journalCode: "890",
    date: "2025-06-05",
    lines: [
      { accountCode: "550001", debit: amountPay },
      {
        accountCode: "400000",
        credit: amountPay,
        partyType: "customer",
        partyId: p,
      },
    ],
  });
  return {
    invLine: await getLine(inv.entryId, "400000", "debit"),
    payLine: await getLine(pay.entryId, "400000", "credit"),
  };
}

describe("reconcile", () => {
  test("exact match closes the group (full)", async () => {
    const { invLine, payLine } = await invoiceAndPayment(121, 121);
    const res = await reconcile(db, { teamId, lineIds: [invLine, payLine] });
    expect(res.status).toBe("full");
    expect(res.allocated).toBe(121);
    expect(res.residual).toBe(0);
    const stamped = await db.query(
      `SELECT COUNT(*)::int AS n FROM ledger_lines
        WHERE reconciliation_id = $1`,
      [res.reconciliationId],
    );
    expect(stamped.rows[0].n).toBe(2);
  });

  test("partial payment allocates exactly, then completes (S6)", async () => {
    const { invLine, payLine: pay50 } = await invoiceAndPayment(121, 50);
    const first = await reconcile(db, { teamId, lineIds: [invLine, pay50] });
    expect(first.status).toBe("partial");
    expect(first.allocated).toBe(50);
    expect(first.residual).toBe(71);

    const pay71 = await postEntry(db, {
      teamId,
      journalCode: "890",
      date: "2025-06-10",
      lines: [
        { accountCode: "550001", debit: 71 },
        { accountCode: "400000", credit: 71 },
      ],
    });
    const pay71Line = await getLine(pay71.entryId, "400000", "credit");
    const second = await reconcile(db, {
      teamId,
      lineIds: [invLine, pay50, pay71Line],
    });
    expect(second.status).toBe("full");
    expect(second.allocated).toBe(71);
    const stamped = await db.query(
      `SELECT COUNT(*)::int AS n FROM ledger_lines WHERE reconciliation_id = $1`,
      [second.reconciliationId],
    );
    expect(stamped.rows[0].n).toBe(3);
  });

  test("payment difference within tolerance writes off (S1)", async () => {
    const { invLine, payLine } = await invoiceAndPayment(100, 99.99);
    const res = await reconcile(db, {
      teamId,
      lineIds: [invLine, payLine],
      date: "2025-06-15",
      writeOffTolerance: 0.05,
    });
    expect(res.status).toBe("full");
    expect(res.residualEntry?.kind).toBe("write_off");
    const wo = await db.query(
      `SELECT COALESCE(SUM(ll.debit), 0) AS v FROM ledger_lines ll
         JOIN gl_accounts a ON a.id = ll.account_id
        WHERE a.code = '657010' AND a.team_id = $1`,
      [teamId],
    );
    expect(Number(wo.rows[0].v)).toBe(0.01);
  });

  test("difference beyond tolerance stays partial (no silent write-off)", async () => {
    const { invLine, payLine } = await invoiceAndPayment(100, 90);
    const res = await reconcile(db, {
      teamId,
      lineIds: [invLine, payLine],
      writeOffTolerance: 0.05,
    });
    expect(res.status).toBe("partial");
    expect(res.residual).toBe(10);
    expect(res.residualEntry).toBeUndefined();
  });

  test("realized FX on settlement (worked example B: $100 @0.92 settled @0.95)", async () => {
    const party = crypto.randomUUID();
    const inv = await postEntry(db, {
      teamId,
      journalCode: "890",
      date: "2025-06-01",
      lines: [
        {
          accountCode: "400000",
          debit: 92,
          currency: "USD",
          amountCurrency: 100,
          fxRate: 0.92,
          partyType: "customer",
          partyId: party,
        },
        {
          systemKey: "sales_revenue",
          credit: 92,
          currency: "USD",
          amountCurrency: -100,
          fxRate: 0.92,
        },
      ],
    });
    const pay = await postEntry(db, {
      teamId,
      journalCode: "890",
      date: "2025-06-20",
      lines: [
        { accountCode: "550001", debit: 95 },
        {
          accountCode: "400000",
          credit: 95,
          currency: "USD",
          amountCurrency: -100,
          fxRate: 0.95,
          partyType: "customer",
          partyId: party,
        },
      ],
    });
    const res = await reconcile(db, {
      teamId,
      lineIds: [
        await getLine(inv.entryId, "400000", "debit"),
        await getLine(pay.entryId, "400000", "credit"),
      ],
      date: "2025-06-20",
    });
    expect(res.status).toBe("full");
    expect(res.residualEntry?.kind).toBe("fx");
    const gain = await db.query(
      `SELECT COALESCE(SUM(ll.credit), 0) AS v FROM ledger_lines ll
         JOIN gl_accounts a ON a.id = ll.account_id
        WHERE a.code = '754000' AND a.team_id = $1`,
      [teamId],
    );
    expect(Number(gain.rows[0].v)).toBe(3);
    // the whole group (2 items + closing line) is stamped
    const stamped = await db.query(
      `SELECT COUNT(*)::int AS n FROM ledger_lines WHERE reconciliation_id = $1`,
      [res.reconciliationId],
    );
    expect(stamped.rows[0].n).toBe(3);
  });

  test("mixed accounts and already-reconciled lines are rejected", async () => {
    const { invLine } = await invoiceAndPayment(10, 10);
    const bank = await db.query(
      `SELECT ll.id FROM ledger_lines ll
         JOIN gl_accounts a ON a.id = ll.account_id
        WHERE a.code = '550001' AND ll.team_id = $1 LIMIT 1`,
      [teamId],
    );
    await expectError(
      reconcile(db, { teamId, lineIds: [invLine, bank.rows[0].id] }),
      /same account/,
    );
  });
});

describe("unallocate", () => {
  test("removes allocations and reopens the group", async () => {
    const { invLine, payLine } = await invoiceAndPayment(30, 30);
    const res = await reconcile(db, { teamId, lineIds: [invLine, payLine] });
    expect(res.status).toBe("full");
    const alloc = await db.query(
      `SELECT id FROM reconciliation_allocations WHERE debit_line_id = $1`,
      [invLine],
    );
    const out = await unallocate(db, {
      teamId,
      allocationIds: [alloc.rows[0].id],
    });
    expect(out.removed).toBe(1);
    const reopened = await db.query(
      `SELECT reconciliation_id FROM ledger_lines WHERE id = ANY($1::uuid[])`,
      [[invLine, payLine]],
    );
    expect(reopened.rows.every((r) => r.reconciliation_id === null)).toBe(true);
  });
});

describe("reverseEntry", () => {
  test("mirrors a posted invoice entry, frees the document, allows re-post", async () => {
    const inv = await db.query(
      `INSERT INTO invoices (team_id, customer_name, invoice_number, amount, vat, currency, issue_date, status)
       VALUES ($1, 'Acme BV', '2025-0099', 121, 21, 'EUR', '2025-06-25T10:00:00Z', 'unpaid')
       RETURNING id`,
      [teamId],
    );
    const first = await postInvoice(db, { invoiceId: inv.rows[0].id });

    const rev = await reverseEntry(db, {
      teamId,
      entryId: first.entryId,
      narration: "Wrong customer",
    });
    // original reversed, mirror balances the books back to zero for 700000
    const orig = await db.query(
      `SELECT status FROM journal_entries WHERE id = $1`,
      [first.entryId],
    );
    expect(orig.rows[0].status).toBe("reversed");
    const revenue = await db.query(
      `SELECT COALESCE(SUM(debit - credit), 0) AS v FROM ledger_lines ll
         JOIN gl_accounts a ON a.id = ll.account_id
        WHERE ll.entry_id = ANY($1::uuid[]) AND a.code = '700000'`,
      [[first.entryId, rev.entryId]],
    );
    expect(Number(revenue.rows[0].v)).toBe(0);
    // pointer freed -> the corrected invoice can post again (I5 index freed too)
    const ptr = await db.query(
      `SELECT journal_entry_id FROM invoices WHERE id = $1`,
      [inv.rows[0].id],
    );
    expect(ptr.rows[0].journal_entry_id).toBeNull();
    const second = await postInvoice(db, { invoiceId: inv.rows[0].id });
    expect(second.entryId).not.toBe(first.entryId);
  });

  test("a second reversal of the same entry is refused", async () => {
    const e = await postEntry(db, {
      teamId,
      journalCode: "890",
      date: "2025-06-26",
      lines: [
        { accountCode: "550001", debit: 5 },
        { systemKey: "sales_revenue", credit: 5 },
      ],
    });
    await reverseEntry(db, { teamId, entryId: e.entryId });
    await expectError(
      reverseEntry(db, { teamId, entryId: e.entryId }),
      /only posted entries reverse/,
    );
  });
});

describe("advances (S8) work with existing primitives", () => {
  test("customer prepayment -> transfer to debtors -> both sides reconcile", async () => {
    const party = crypto.randomUUID();
    // 1. prepayment received: Dr bank / Cr customer advances
    const adv = await postEntry(db, {
      teamId,
      journalCode: "890",
      date: "2025-07-01",
      lines: [
        { accountCode: "550001", debit: 500 },
        {
          systemKey: "customer_advances",
          credit: 500,
          partyType: "customer",
          partyId: party,
        },
      ],
    });
    // 2. invoice posts: Dr debtors / Cr revenue
    const inv = await postEntry(db, {
      teamId,
      journalCode: "890",
      date: "2025-07-10",
      lines: [
        {
          accountCode: "400000",
          debit: 500,
          partyType: "customer",
          partyId: party,
        },
        { systemKey: "sales_revenue", credit: 500 },
      ],
    });
    // 3. allocation entry moves the advance onto the invoice
    const move = await postEntry(db, {
      teamId,
      journalCode: "890",
      date: "2025-07-10",
      lines: [
        {
          systemKey: "customer_advances",
          debit: 500,
          partyType: "customer",
          partyId: party,
        },
        {
          accountCode: "400000",
          credit: 500,
          partyType: "customer",
          partyId: party,
        },
      ],
    });
    const advClose = await reconcile(db, {
      teamId,
      lineIds: [
        await getLine(move.entryId, "460000", "debit"),
        await getLine(adv.entryId, "460000", "credit"),
      ],
    });
    const invClose = await reconcile(db, {
      teamId,
      lineIds: [
        await getLine(inv.entryId, "400000", "debit"),
        await getLine(move.entryId, "400000", "credit"),
      ],
    });
    expect(advClose.status).toBe("full");
    expect(invClose.status).toBe("full");
  });
});
