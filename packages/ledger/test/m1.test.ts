/**
 * M1 acceptance tests on real Postgres: posting rules for invoices (incl.
 * credit-note mirror), bank transactions (VAT-deductibility split, refund sign
 * inversion, transfer clearing, FX card spend), open-item opening balances, and
 * the v_trial_balance view. Extends the M0 setup with minimal stubs of the
 * Midday document tables that migration 0013 alters.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Pool, type PoolClient } from "pg";
import { buildOpeningLines, postOpening } from "../src/opening.js";
import { postInvoice } from "../src/post-invoice.js";
import { postTransaction } from "../src/post-transaction.js";
import { seedBelgianLedger } from "../src/seed.js";
import { expectError, initTestDb, TEST_DB_URL } from "./helpers/setup.js";

const pool = new Pool({ connectionString: TEST_DB_URL });
let db: PoolClient;
let teamId: string;
let bankAccountId: string;
let cardAccountId: string;

/** Sum a column of an entry's lines, filtered by account code. */
async function lineAmount(
  entryId: string,
  code: string,
  side: "debit" | "credit",
): Promise<number> {
  const r = await db.query(
    `SELECT COALESCE(SUM(ll.${side}), 0) AS v
       FROM ledger_lines ll JOIN gl_accounts a ON a.id = ll.account_id
      WHERE ll.entry_id = $1 AND a.code = $2`,
    [entryId, code],
  );
  return Number(r.rows[0].v);
}

beforeAll(async () => {
  db = await pool.connect();
  teamId = await initTestDb(db);
  await db.query("BEGIN");
  await seedBelgianLedger(db, { teamId, years: [2025, 2026] });
  await db.query("COMMIT");

  // Bank accounts: KBC (EUR-locked GL 550001, journal 500) + card (570).
  const kbcGl = await db.query(
    `INSERT INTO gl_accounts (team_id, code, name, type, currency)
     VALUES ($1, '550001', 'KBC zichtrekening', 'asset', 'EUR') RETURNING id`,
    [teamId],
  );
  const cardGl = await db.query(
    `INSERT INTO gl_accounts (team_id, code, name, type)
     VALUES ($1, '570000', 'Debetkaart', 'asset') RETURNING id`,
    [teamId],
  );
  const kbc = await db.query(
    `INSERT INTO bank_accounts (team_id, name, currency) VALUES ($1, 'KBC', 'EUR') RETURNING id`,
    [teamId],
  );
  bankAccountId = kbc.rows[0].id;
  const card = await db.query(
    `INSERT INTO bank_accounts (team_id, name, currency) VALUES ($1, 'Card', 'EUR') RETURNING id`,
    [teamId],
  );
  cardAccountId = card.rows[0].id;
  await db.query(
    `UPDATE journals SET bank_account_id = $2, gl_account_id = $3 WHERE team_id = $1 AND code = '500'`,
    [teamId, bankAccountId, kbcGl.rows[0].id],
  );
  await db.query(
    `UPDATE journals SET bank_account_id = $2, gl_account_id = $3 WHERE team_id = $1 AND code = '570'`,
    [teamId, cardAccountId, cardGl.rows[0].id],
  );
  // Category mapped to a deductibility-bucketed account (50% VAT deductible).
  await db.query(
    `INSERT INTO gl_accounts (team_id, code, name, type, vat_deductible_pct)
     VALUES ($1, '612900', 'Onthaalkosten beperkt', 'expense', 50)`,
    [teamId],
  );
  await db.query(
    `INSERT INTO transaction_categories (team_id, slug, name, gl_account_id)
     SELECT $1, 'meals', 'Meals', id FROM gl_accounts WHERE team_id = $1 AND code = '612900'`,
    [teamId],
  );
  await db.query(
    `INSERT INTO transaction_categories (team_id, slug, name) VALUES ($1, 'transfer', 'Transfer')`,
    [teamId],
  );
  // Chart rows the opening fixture references.
  await db.query(
    `INSERT INTO gl_accounts (team_id, code, name, type) VALUES
       ($1, '111900', 'Inbreng buiten kapitaal', 'equity'),
       ($1, '232000', 'Uitrusting', 'asset')`,
    [teamId],
  );
});

afterAll(async () => {
  db?.release();
  await pool.end();
});

describe("postInvoice", () => {
  let invoiceId: string;

  test("sales invoice posts Dr debtors / Cr revenue / Cr VAT with auto tax code", async () => {
    const customer = crypto.randomUUID();
    const inv = await db.query(
      `INSERT INTO invoices (team_id, customer_id, customer_name, invoice_number, amount, vat, currency, issue_date, status)
       VALUES ($1, $2, 'Acme BV', '2025-0001', 121, 21, 'EUR', '2025-06-05T10:00:00Z', 'unpaid')
       RETURNING id`,
      [teamId, customer],
    );
    invoiceId = inv.rows[0].id;
    const res = await postInvoice(db, { invoiceId });
    expect(res.entryNumber).toBe("700-00001");
    expect(await lineAmount(res.entryId, "400000", "debit")).toBe(121);
    expect(await lineAmount(res.entryId, "700000", "credit")).toBe(100);
    expect(await lineAmount(res.entryId, "451000", "credit")).toBe(21);
    // auto-matched V21, snapshotted tax base
    const tax = await db.query(
      `SELECT t.code, ll.tax_base FROM ledger_lines ll
         JOIN tax_codes t ON t.id = ll.tax_code_id
         JOIN gl_accounts a ON a.id = ll.account_id
        WHERE ll.entry_id = $1 AND a.code = '451000'`,
      [res.entryId],
    );
    expect(tax.rows[0].code).toBe("V21");
    expect(Number(tax.rows[0].tax_base)).toBe(100);
    // party + back-pointer
    const ptr = await db.query(
      `SELECT journal_entry_id FROM invoices WHERE id = $1`,
      [invoiceId],
    );
    expect(ptr.rows[0].journal_entry_id).toBe(res.entryId);
  });

  test("re-posting the same invoice is refused", async () => {
    await expectError(postInvoice(db, { invoiceId }), /already posted/);
  });

  test("credit note posts the exact mirror (S7)", async () => {
    const inv = await db.query(
      `INSERT INTO invoices (team_id, customer_name, invoice_number, amount, vat, currency, issue_date, status, invoice_type, credited_invoice_id)
       VALUES ($1, 'Acme BV', 'CN-2025-0001', 60.50, 10.50, 'EUR', '2025-06-20T10:00:00Z', 'unpaid', 'credit_note', $2)
       RETURNING id`,
      [teamId, invoiceId],
    );
    const res = await postInvoice(db, { invoiceId: inv.rows[0].id });
    expect(await lineAmount(res.entryId, "400000", "credit")).toBe(60.5);
    expect(await lineAmount(res.entryId, "700000", "debit")).toBe(50);
    expect(await lineAmount(res.entryId, "451000", "debit")).toBe(10.5);
  });

  test("draft invoices refuse to post", async () => {
    const inv = await db.query(
      `INSERT INTO invoices (team_id, amount, vat, currency, issue_date, status)
       VALUES ($1, 121, 21, 'EUR', '2025-06-21T10:00:00Z', 'draft') RETURNING id`,
      [teamId],
    );
    await expectError(
      postInvoice(db, { invoiceId: inv.rows[0].id }),
      /'draft' does not post/,
    );
  });
});

describe("postTransaction", () => {
  test("purchase with VAT splits deductible 50/50 into cost (§5b.1)", async () => {
    const txn = await db.query(
      `INSERT INTO transactions (team_id, date, name, amount, currency, bank_account_id, category_slug, tax_amount)
       VALUES ($1, '2025-06-10', 'Restaurant Comme Chez Soi', -121, 'EUR', $2, 'meals', 21)
       RETURNING id`,
      [teamId, bankAccountId],
    );
    const res = await postTransaction(db, { transactionId: txn.rows[0].id });
    expect(res.entryNumber).toBe("500-00001");
    expect(await lineAmount(res.entryId, "550001", "credit")).toBe(121);
    // VAT €21, 50% deductible -> €10.50 to 411000; cost = 100 + 10.50
    expect(await lineAmount(res.entryId, "612900", "debit")).toBe(110.5);
    expect(await lineAmount(res.entryId, "411000", "debit")).toBe(10.5);
    const snap = await db.query(
      `SELECT vat_deductible_pct_used, tax_base FROM ledger_lines ll
         JOIN gl_accounts a ON a.id = ll.account_id
        WHERE ll.entry_id = $1 AND a.code = '411000'`,
      [res.entryId],
    );
    expect(Number(snap.rows[0].vat_deductible_pct_used)).toBe(50);
    expect(Number(snap.rows[0].tax_base)).toBe(100);
  });

  test("refund inverts the sides (S2 sign inversion)", async () => {
    const txn = await db.query(
      `INSERT INTO transactions (team_id, date, name, amount, currency, bank_account_id, category_slug)
       VALUES ($1, '2025-06-11', 'Techpunt refund', 50, 'EUR', $2, 'meals') RETURNING id`,
      [teamId, bankAccountId],
    );
    const res = await postTransaction(db, { transactionId: txn.rows[0].id });
    expect(await lineAmount(res.entryId, "550001", "debit")).toBe(50);
    expect(await lineAmount(res.entryId, "612900", "credit")).toBe(50);
  });

  test("transfers clear through 580000, never P&L (S2)", async () => {
    const txn = await db.query(
      `INSERT INTO transactions (team_id, date, name, amount, currency, bank_account_id, category_slug)
       VALUES ($1, '2025-06-12', 'FUNDING REVOLUT', -1000, 'EUR', $2, 'transfer') RETURNING id`,
      [teamId, bankAccountId],
    );
    const res = await postTransaction(db, { transactionId: txn.rows[0].id });
    expect(await lineAmount(res.entryId, "550001", "credit")).toBe(1000);
    expect(await lineAmount(res.entryId, "580000", "debit")).toBe(1000);
  });

  test("FX card spend posts dual amounts from baseAmount", async () => {
    const txn = await db.query(
      `INSERT INTO transactions (team_id, date, name, amount, currency, bank_account_id, category_slug, base_amount, base_currency)
       VALUES ($1, '2025-06-13', 'OpenAI ChatGPT', -42, 'USD', $2, 'meals', -38.50, 'EUR')
       RETURNING id`,
      [teamId, cardAccountId],
    );
    const res = await postTransaction(db, { transactionId: txn.rows[0].id });
    expect(res.entryNumber).toBe("570-00001");
    expect(await lineAmount(res.entryId, "570000", "credit")).toBe(38.5);
    expect(await lineAmount(res.entryId, "612900", "debit")).toBe(38.5);
    const bankLine = await db.query(
      `SELECT ll.currency, ll.amount_currency FROM ledger_lines ll
         JOIN gl_accounts a ON a.id = ll.account_id
        WHERE ll.entry_id = $1 AND a.code = '570000'`,
      [res.entryId],
    );
    expect(bankLine.rows[0].currency).toBe("USD");
    expect(Number(bankLine.rows[0].amount_currency)).toBe(-42);
  });

  test("uncategorised and unmapped transactions refuse to post", async () => {
    const t1 = await db.query(
      `INSERT INTO transactions (team_id, date, name, amount, currency, bank_account_id)
       VALUES ($1, '2025-06-14', 'Mystery', -10, 'EUR', $2) RETURNING id`,
      [teamId, bankAccountId],
    );
    await expectError(
      postTransaction(db, { transactionId: t1.rows[0].id }),
      /no category/,
    );
    await db.query(
      `INSERT INTO transaction_categories (team_id, slug, name) VALUES ($1, 'unmapped-cat', 'X')`,
      [teamId],
    );
    const t2 = await db.query(
      `INSERT INTO transactions (team_id, date, name, amount, currency, bank_account_id, category_slug)
       VALUES ($1, '2025-06-14', 'Mystery 2', -10, 'EUR', $2, 'unmapped-cat') RETURNING id`,
      [teamId, bankAccountId],
    );
    await expectError(
      postTransaction(db, { transactionId: t2.rows[0].id }),
      /no gl_account_id mapping/,
    );
  });

  test("teamId mismatch refuses to post (API-key scoping)", async () => {
    const t = await db.query(
      `INSERT INTO transactions (team_id, date, name, amount, currency, bank_account_id, category_slug)
       VALUES ($1, '2025-06-16', 'Scoped', -10, 'EUR', $2, 'meals') RETURNING id`,
      [teamId, bankAccountId],
    );
    await expectError(
      postTransaction(db, {
        transactionId: t.rows[0].id,
        teamId: "00000000-0000-0000-0000-000000000001",
      }),
      /not found/,
    );
  });

  test("income override routes VAT to vat_payable, not vat_deductible", async () => {
    const t = await db.query(
      `INSERT INTO transactions (team_id, date, name, amount, currency, bank_account_id)
       VALUES ($1, '2025-06-17', 'Verkoop cash', 121, 'EUR', $2) RETURNING id`,
      [teamId, bankAccountId],
    );
    const res = await postTransaction(db, {
      transactionId: t.rows[0].id,
      override: { accountCode: "700000", vatAmount: 21 },
    });
    const lines = await db.query(
      `SELECT a.system_key, ll.debit, ll.credit FROM ledger_lines ll
         JOIN gl_accounts a ON a.id = ll.account_id
        WHERE ll.entry_id = $1 AND a.system_key IN ('vat_payable','vat_deductible')`,
      [res.entryId],
    );
    expect(lines.rows.length).toBe(1);
    expect(lines.rows[0].system_key).toBe("vat_payable");
    expect(Number(lines.rows[0].credit)).toBe(21);
  });

  test("bookie override books an uncategorised transaction with a VAT split", async () => {
    const t = await db.query(
      `INSERT INTO transactions (team_id, date, name, amount, currency, bank_account_id)
       VALUES ($1, '2025-06-15', 'Resto zonder categorie', -121, 'EUR', $2) RETURNING id`,
      [teamId, bankAccountId],
    );
    const res = await postTransaction(db, {
      transactionId: t.rows[0].id,
      override: { accountCode: "612900", vatAmount: 21 },
    });
    const lines = await db.query(
      `SELECT a.code, a.system_key, ll.debit, ll.credit FROM ledger_lines ll
         JOIN gl_accounts a ON a.id = ll.account_id
        WHERE ll.entry_id = $1 ORDER BY a.code`,
      [res.entryId],
    );
    // 612900 is 50% deductible: cost 100 + 10.50 non-deductible VAT, 10.50 to 411000.
    const cost = lines.rows.find((r) => r.code === "612900");
    const vat = lines.rows.find((r) => r.system_key === "vat_deductible");
    const bank = lines.rows.find((r) => r.code === "550001");
    expect(Number(cost?.debit)).toBe(110.5);
    expect(Number(vat?.debit)).toBe(10.5);
    expect(Number(bank?.credit)).toBe(121);
  });
});

describe("opening balances (S9, open-item granularity)", () => {
  const tb = [
    { code: "111900", name: "Inbreng", debit: 0, credit: 5000 },
    { code: "140000", name: "Overgedragen winst", debit: 0, credit: 21885.56 },
    { code: "232000", name: "Uitrusting", debit: 3189.87, credit: 0 },
    { code: "550001", name: "KBC", debit: 16715.11, credit: 0 },
    { code: "400000", name: "Klanten", debit: 7381, credit: 0 },
    { code: "440000", name: "Leveranciers", debit: 0, credit: 401.42 },
    { code: "451900", name: "RC btw", debit: 1, credit: 0 },
  ];
  const arItems = [
    {
      relation: "43 - Be Impact",
      invoice: "20230024",
      date: "2024-12-29",
      amount: 2299,
    },
    {
      relation: "119 - Citizen Spring",
      invoice: "20230025",
      date: "2024-12-29",
      amount: 5082,
    },
  ];
  const apItems = [
    { relation: "Peppol supplier", invoice: "AF24-001", amount: 401.42 },
  ];

  test("mismatched open items are rejected before posting", () => {
    expect(() =>
      buildOpeningLines({ tb, arItems: arItems.slice(0, 1), apItems }),
    ).toThrow(/open AR items/);
  });

  test("opening posts per-item AR/AP lines and balances", async () => {
    const lines = buildOpeningLines({ tb, arItems, apItems });
    const res = await postOpening(db, { teamId, date: "2025-01-01", lines });
    // 5 TB lines + 2 AR items + 1 AP item
    const count = await db.query(
      `SELECT COUNT(*)::int AS n FROM ledger_lines WHERE entry_id = $1`,
      [res.entryId],
    );
    expect(count.rows[0].n).toBe(8);
    expect(await lineAmount(res.entryId, "400000", "debit")).toBe(7381);
    const items = await db.query(
      `SELECT ll.description FROM ledger_lines ll
         JOIN gl_accounts a ON a.id = ll.account_id
        WHERE ll.entry_id = $1 AND a.code = '400000' ORDER BY ll.debit DESC`,
      [res.entryId],
    );
    expect(items.rows[0].description).toContain("20230025");
    expect(items.rows[1].description).toContain("20230024");
  });

  test("a second opening for the same team is refused", async () => {
    const lines = buildOpeningLines({ tb, arItems, apItems });
    await expectError(
      postOpening(db, { teamId, date: "2025-01-01", lines }),
      /already has a posted opening/,
    );
  });
});

describe("v_trial_balance", () => {
  test("balances to zero and shows the opening + activity", async () => {
    const total = await db.query(
      `SELECT COALESCE(SUM(balance), 0) AS total FROM v_trial_balance WHERE team_id = $1`,
      [teamId],
    );
    expect(Number(total.rows[0].total)).toBe(0);
    const debtors = await db.query(
      `SELECT debit, credit FROM v_trial_balance WHERE team_id = $1 AND code = '400000'`,
      [teamId],
    );
    // opening 7381 + invoice 121 debit; CN 60.50 credit
    expect(Number(debtors.rows[0].debit)).toBe(7502);
    expect(Number(debtors.rows[0].credit)).toBe(60.5);
  });
});
