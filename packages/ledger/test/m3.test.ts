/**
 * M3 acceptance: a golden quarter of Belgian activity produces the expected VAT
 * grid values (incl. partial deduction and direction-aware credit notes) and a
 * well-formed Intervat VATConsignment XML. Real Postgres, engine-posted data
 * only — the generator never sees fixtures, it reads the ledger.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Pool, type PoolClient } from "pg";
import { postInvoice } from "../src/post-invoice.js";
import { postTransaction } from "../src/post-transaction.js";
import { seedBelgianLedger } from "../src/seed.js";
import { generateVatReturn } from "../src/vat-return.js";
import { expectError, initTestDb, TEST_DB_URL } from "./helpers/setup.js";

const pool = new Pool({ connectionString: TEST_DB_URL });
let db: PoolClient;
let teamId: string;
let bankAccountId: string;

const DECLARANT = {
  vatNumber: "0805193139",
  name: "Spark Collective",
  street: "Teststraat 1",
  postCode: "1000",
  city: "Brussel",
  email: "test@sparkcollective.be",
};

beforeAll(async () => {
  db = await pool.connect();
  teamId = await initTestDb(db);
  await db.query("BEGIN");
  await seedBelgianLedger(db, { teamId, years: [2025, 2026] });
  await db.query("COMMIT");
  // bank + category fixture (as in M1)
  const gl = await db.query(
    `INSERT INTO gl_accounts (team_id, code, name, type, currency)
     VALUES ($1, '550001', 'KBC', 'asset', 'EUR') RETURNING id`,
    [teamId],
  );
  const bank = await db.query(
    `INSERT INTO bank_accounts (team_id, name, currency) VALUES ($1, 'KBC', 'EUR') RETURNING id`,
    [teamId],
  );
  bankAccountId = bank.rows[0].id;
  await db.query(
    `UPDATE journals SET bank_account_id = $2, gl_account_id = $3
      WHERE team_id = $1 AND code = '500'`,
    [teamId, bankAccountId, gl.rows[0].id],
  );
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

  // ---- the golden quarter (Q2 2025) ----
  // 1. domestic sale: 242 incl. 42 VAT (V21) -> 03: 200, 54: 42
  const inv1 = await db.query(
    `INSERT INTO invoices (team_id, customer_name, invoice_number, amount, vat, currency, issue_date, status)
     VALUES ($1, 'Acme BV', '2025-0001', 242, 42, 'EUR', '2025-04-10T10:00:00Z', 'unpaid') RETURNING id`,
    [teamId],
  );
  await postInvoice(db, { invoiceId: inv1.rows[0].id });
  // 2. credit note on it: 60.50 incl. 10.50 -> 49: 50, 64: 10.50
  const cn = await db.query(
    `INSERT INTO invoices (team_id, customer_name, invoice_number, amount, vat, currency, issue_date, status, invoice_type, credited_invoice_id)
     VALUES ($1, 'Acme BV', 'CN-2025-0001', 60.50, 10.50, 'EUR', '2025-05-02T10:00:00Z', 'unpaid', 'credit_note', $2) RETURNING id`,
    [teamId, inv1.rows[0].id],
  );
  await postInvoice(db, { invoiceId: cn.rows[0].id });
  // 3. intra-EU B2B service sale: 500 at 0% (V00-ICS) -> 44: 500
  const inv2 = await db.query(
    `INSERT INTO invoices (team_id, customer_name, invoice_number, amount, vat, currency, issue_date, status)
     VALUES ($1, 'NL Client BV', '2025-0002', 500, 0, 'EUR', '2025-05-15T10:00:00Z', 'unpaid') RETURNING id`,
    [teamId],
  );
  await postInvoice(db, { invoiceId: inv2.rows[0].id, taxCode: "V00-ICS" });
  // 4. restaurant purchase via bank: -121 with 21 VAT at 50% deductible
  //    -> 82: 100 (base), 59: 10.50 (deductible only)
  const txn = await db.query(
    `INSERT INTO transactions (team_id, date, name, amount, currency, bank_account_id, category_slug, tax_amount)
     VALUES ($1, '2025-05-20', 'Restaurant', -121, 'EUR', $2, 'meals', 21) RETURNING id`,
    [teamId, bankAccountId],
  );
  await postTransaction(db, { transactionId: txn.rows[0].id });
  // 5. purchase refund with VAT: +12.10 with 2.10 tax -> 85: 10, 63: 1.05
  const refund = await db.query(
    `INSERT INTO transactions (team_id, date, name, amount, currency, bank_account_id, category_slug, tax_amount)
     VALUES ($1, '2025-06-01', 'Refund', 12.10, 'EUR', $2, 'meals', 2.10) RETURNING id`,
    [teamId, bankAccountId],
  );
  await postTransaction(db, { transactionId: refund.rows[0].id });
  // 6. zero-rated sale WITHOUT a tax code -> must surface as a warning, no box
  const inv3 = await db.query(
    `INSERT INTO invoices (team_id, customer_name, invoice_number, amount, vat, currency, issue_date, status)
     VALUES ($1, 'Unknown Corp', '2025-0003', 100, 0, 'EUR', '2025-06-20T10:00:00Z', 'unpaid') RETURNING id`,
    [teamId],
  );
  await postInvoice(db, { invoiceId: inv3.rows[0].id });
});

afterAll(async () => {
  db?.release();
  await pool.end();
});

describe("generateVatReturn (golden quarter Q2 2025)", () => {
  test("produces the expected grid values", async () => {
    const ret = await generateVatReturn(db, {
      teamId,
      period: { year: 2025, quarter: 2 },
      declarant: DECLARANT,
    });
    expect(ret.grids).toEqual({
      "03": "200.00", // domestic sales base 21%
      "44": "500.00", // intra-EU services
      "49": "50.00", // CN issued, base
      "54": "42.00", // output VAT
      "59": "10.50", // deductible input VAT (50% of 21)
      "63": "1.05", // VAT to repay on CN received (50% of 2.10)
      "64": "10.50", // VAT to recover on CN issued
      "82": "100.00", // services purchase base (61x heuristic)
      "85": "10.00", // CN received, base
      // balance: due (54+63 = 43.05) - deductible (59+64 = 21.00) = 22.05
      "71": "22.05",
    });
  });

  test("warns on the unverified-form check, heuristic mapping, and unmapped zero-rated sales", async () => {
    const ret = await generateVatReturn(db, {
      teamId,
      period: { year: 2025, quarter: 2 },
      declarant: DECLARANT,
    });
    expect(ret.warnings.some((w) => w.includes("Verify boxes"))).toBe(true);
    expect(ret.warnings.some((w) => w.includes("heuristically"))).toBe(true);
    expect(
      ret.warnings.some(
        (w) => w.includes("without a tax code") && w.includes("100.00"),
      ),
    ).toBe(true);
  });

  test("emits well-formed VATConsignment XML for the quarter", async () => {
    const ret = await generateVatReturn(db, {
      teamId,
      period: { year: 2025, quarter: 2 },
      declarant: DECLARANT,
    });
    expect(ret.xml).toContain('<ns2:VATConsignment VATDeclarationsNbr="1"');
    expect(ret.xml).toContain("<VATNumber>0805193139</VATNumber>");
    expect(ret.xml).toContain("<ns2:Quarter>2</ns2:Quarter>");
    expect(ret.xml).toContain("<ns2:Year>2025</ns2:Year>");
    expect(ret.xml).toContain('<ns2:Amount GridNumber="54">42.00</ns2:Amount>');
    expect(ret.xml).toContain('<ns2:Amount GridNumber="71">22.05</ns2:Amount>');
    expect(ret.xml).toContain(
      "<ns2:ClientListingNihil>NO</ns2:ClientListingNihil>",
    );
    expect(ret.xml).toContain('<ns2:Ask Restitution="NO"/>');
    // no zero boxes, no unrequested grids
    expect(ret.xml).not.toContain('GridNumber="72"');
  });

  test("a monthly period with no activity yields empty grids", async () => {
    const ret = await generateVatReturn(db, {
      teamId,
      period: { year: 2026, month: 1 },
      declarant: DECLARANT,
    });
    expect(ret.grids).toEqual({});
    expect(ret.xml).toContain("<ns2:Month>1</ns2:Month>");
  });

  test("rejects an invalid declarant VAT number", async () => {
    await expectError(
      generateVatReturn(db, {
        teamId,
        period: { year: 2025, quarter: 2 },
        declarant: { ...DECLARANT, vatNumber: "12345" },
      }),
      /10 digits/,
    );
  });
});
