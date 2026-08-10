/**
 * M12 acceptance: purchase documents. An incoming supplier invoice books as
 * an open item on trade creditors (Dr cost + Dr deductible VAT / Cr 440000);
 * a credit note is the exact mirror; the ERPNext guards hold (a linked CN
 * must match its invoice's supplier and currency, and CNs against one
 * invoice cannot exceed it); credit-side coded lines land in grids 85/63;
 * and the Combell net-payment shape settles through plain M2 allocation.
 *
 * The first cases reproduce the real trigger pair: Combell factuur
 * 260807125 (+170,57 = 140,97 + 29,60) and creditnota 260807528
 * (-113,72 = 93,98 + 19,74), paid with one net 56,85.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Pool, type PoolClient } from "pg";
import { postEntry } from "../src/post.js";
import { postPurchaseDocument } from "../src/post-purchase-document.js";
import { reconcile } from "../src/reconcile.js";
import { seedBelgianLedger } from "../src/seed.js";
import { computeVatGrids } from "../src/vat-return.js";
import { expectError, initTestDb, TEST_DB_URL } from "./helpers/setup.js";

const pool = new Pool({ connectionString: TEST_DB_URL });
let db: PoolClient;
let teamId: string;

let seq = 0;
async function makeDoc(opts: {
  number: string;
  kind: "invoice" | "credit_note";
  supplier?: string;
  vat?: string | null;
  currency?: string;
  credits?: string | null;
  date?: string;
  lines: Array<{
    code: string;
    amount: number;
    taxCode?: string | null;
    taxAmount?: number;
    description?: string;
  }>;
  /** Override the header totals to test the sum guards. */
  total?: number;
  taxTotal?: number;
}): Promise<string> {
  const taxTotal =
    opts.taxTotal ??
    Math.round(opts.lines.reduce((s, l) => s + (l.taxAmount ?? 0), 0) * 100) /
      100;
  const total =
    opts.total ??
    Math.round(
      opts.lines.reduce((s, l) => s + l.amount + (l.taxAmount ?? 0), 0) * 100,
    ) / 100;
  const res = await db.query(
    `INSERT INTO purchase_documents
       (team_id, supplier_name, supplier_vat, document_number, kind,
        credits_document_id, issue_date, currency, amount, tax_amount)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      teamId,
      opts.supplier ?? "Combell nv",
      opts.vat === undefined ? "BE0541977701" : opts.vat,
      opts.number,
      opts.kind,
      opts.credits ?? null,
      opts.date ?? "2026-08-07",
      opts.currency ?? "EUR",
      total,
      taxTotal,
    ],
  );
  const id = res.rows[0].id;
  let pos = 0;
  for (const l of opts.lines) {
    await db.query(
      `INSERT INTO purchase_document_lines
         (purchase_document_id, team_id, position, description,
          gl_account_code, amount, tax_code, tax_amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        teamId,
        pos++,
        l.description ?? `line ${++seq}`,
        l.code,
        l.amount,
        l.taxCode === undefined ? "P21" : l.taxCode,
        l.taxAmount ?? 0,
      ],
    );
  }
  return id;
}

async function entryLines(entryId: string) {
  const res = await db.query(
    `SELECT a.code, ll.debit::float8 AS dr, ll.credit::float8 AS cr,
            tc.code AS tax, ll.tax_base::float8 AS base, ll.id
       FROM ledger_lines ll
       JOIN gl_accounts a ON a.id = ll.account_id
       LEFT JOIN tax_codes tc ON tc.id = ll.tax_code_id
      WHERE ll.entry_id = $1 ORDER BY a.code, ll.debit DESC`,
    [entryId],
  );
  return res.rows;
}

let invoiceId: string;
let invoiceEntryId: string;
let creditNoteId: string;

beforeAll(async () => {
  db = await pool.connect();
  teamId = await initTestDb(db);
  await db.query("BEGIN");
  await seedBelgianLedger(db, { teamId, years: [2026] });
  await db.query("COMMIT");
  await db.query(
    `INSERT INTO gl_accounts (team_id, code, name, type) VALUES
       ($1, '611010', 'Computerbenodigdheden', 'expense'),
       ($1, '550001', 'KBC zichtrekening', 'asset')
     ON CONFLICT (team_id, code) DO NOTHING`,
    [teamId],
  );
  await db.query(
    `INSERT INTO gl_accounts (team_id, code, name, type, vat_deductible_pct)
     VALUES ($1, '611901', 'Brandstof personenwagens', 'expense', 50)
     ON CONFLICT (team_id, code) DO NOTHING`,
    [teamId],
  );
});

afterAll(async () => {
  db?.release();
  await pool.end();
});

describe("purchase documents (M12)", () => {
  test("the Combell invoice books Dr cost + Dr VAT / Cr 440000", async () => {
    invoiceId = await makeDoc({
      number: "260807125",
      kind: "invoice",
      lines: [{ code: "611010", amount: 140.97, taxAmount: 29.6 }],
    });
    const { entryId } = await postPurchaseDocument(db, {
      purchaseDocumentId: invoiceId,
      teamId,
    });
    invoiceEntryId = entryId;

    const lines = await entryLines(entryId);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ code: "411000", dr: 29.6, cr: 0, tax: "P21", base: 140.97 });
    expect(lines[1]).toMatchObject({ code: "440000", dr: 0, cr: 170.57 });
    expect(lines[2]).toMatchObject({ code: "611010", dr: 140.97, cr: 0, tax: "P21" });

    const doc = await db.query(
      `SELECT journal_entry_id, status FROM purchase_documents WHERE id = $1`,
      [invoiceId],
    );
    expect(doc.rows[0].journal_entry_id).toBe(entryId);
    expect(doc.rows[0].status).toBe("posted");
  });

  test("the credit note is the exact mirror, linked to its invoice", async () => {
    creditNoteId = await makeDoc({
      number: "260807528",
      kind: "credit_note",
      credits: invoiceId,
      lines: [{ code: "611010", amount: 93.98, taxAmount: 19.74 }],
    });
    const { entryId } = await postPurchaseDocument(db, {
      purchaseDocumentId: creditNoteId,
      teamId,
    });

    const lines = await entryLines(entryId);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ code: "411000", dr: 0, cr: 19.74, tax: "P21", base: 93.98 });
    expect(lines[1]).toMatchObject({ code: "440000", dr: 113.72, cr: 0 });
    expect(lines[2]).toMatchObject({ code: "611010", dr: 0, cr: 93.98, tax: "P21" });
  });

  test("grids: invoice feeds 82/59, credit note feeds 85/63", async () => {
    const { grids } = await computeVatGrids(db, {
      teamId,
      period: { year: 2026, quarter: 3 },
    });
    expect(grids["82"]).toBe("140.97");
    expect(grids["59"]).toBe("29.60");
    expect(grids["85"]).toBe("93.98");
    expect(grids["63"]).toBe("19.74");
  });

  test("one net payment settles invoice minus credit note (the Combell shape)", async () => {
    const accounts = await db.query(
      `SELECT code, id FROM gl_accounts WHERE team_id = $1 AND code IN ('440000','550001')`,
      [teamId],
    );
    const byCode = Object.fromEntries(accounts.rows.map((r) => [r.code, r.id]));
    await postEntry(db, {
      teamId,
      journalCode: "500",
      date: "2026-08-10",
      narration: "Combell netto betaling",
      sourceType: "manual",
      lines: [
        { accountId: byCode["440000"], debit: 56.85, description: "Combell netto" },
        { accountId: byCode["550001"], credit: 56.85, description: "Combell netto" },
      ],
    });

    const open = await db.query(
      `SELECT ll.id FROM ledger_lines ll
        WHERE ll.team_id = $1 AND ll.account_id = $2`,
      [teamId, byCode["440000"]],
    );
    expect(open.rows).toHaveLength(3);
    const result = await reconcile(db, {
      teamId,
      lineIds: open.rows.map((r) => r.id),
    });
    expect(result.status).toBe("full");
    expect(result.residual).toBe(0);
  });

  test("guards: double post, sum mismatches, unknown codes", async () => {
    await expectError(
      postPurchaseDocument(db, { purchaseDocumentId: invoiceId, teamId }),
      /already posted/,
    );

    const badTotal = await makeDoc({
      number: "G-1",
      kind: "invoice",
      total: 999,
      lines: [{ code: "611010", amount: 100, taxAmount: 21 }],
    });
    await expectError(
      postPurchaseDocument(db, { purchaseDocumentId: badTotal, teamId }),
      /lines sum to/,
    );

    const badTax = await makeDoc({
      number: "G-2",
      kind: "invoice",
      total: 121,
      taxTotal: 10,
      lines: [{ code: "611010", amount: 100, taxAmount: 21 }],
    });
    await expectError(
      postPurchaseDocument(db, { purchaseDocumentId: badTax, teamId }),
      /line VAT sums to/,
    );

    const badAccount = await makeDoc({
      number: "G-3",
      kind: "invoice",
      lines: [{ code: "699999", amount: 10 }],
    });
    await expectError(
      postPurchaseDocument(db, { purchaseDocumentId: badAccount, teamId }),
      /unknown account/,
    );

    const badCode = await makeDoc({
      number: "G-4",
      kind: "invoice",
      lines: [{ code: "611010", amount: 10, taxCode: "NOPE" }],
    });
    await expectError(
      postPurchaseDocument(db, { purchaseDocumentId: badCode, teamId }),
      /unknown tax code/,
    );
  });

  test("ERPNext guards: supplier match, currency match, CNs cannot exceed the invoice", async () => {
    const wrongSupplier = await makeDoc({
      number: "CN-S",
      kind: "credit_note",
      supplier: "Somebody Else bv",
      vat: "BE0999999999",
      credits: invoiceId,
      lines: [{ code: "611010", amount: 10, taxAmount: 2.1 }],
    });
    await expectError(
      postPurchaseDocument(db, { purchaseDocumentId: wrongSupplier, teamId }),
      /does not match the supplier/,
    );

    const wrongCurrency = await makeDoc({
      number: "CN-C",
      kind: "credit_note",
      currency: "USD",
      credits: invoiceId,
      lines: [{ code: "611010", amount: 10, taxAmount: 2.1 }],
    });
    await expectError(
      postPurchaseDocument(db, { purchaseDocumentId: wrongCurrency, teamId }),
      /is in USD but invoice/,
    );

    // 113,72 already credited; another 60,00 would exceed 170,57.
    const tooMuch = await makeDoc({
      number: "CN-X",
      kind: "credit_note",
      credits: invoiceId,
      lines: [{ code: "611010", amount: 49.59, taxAmount: 10.41 }],
    });
    await expectError(
      postPurchaseDocument(db, { purchaseDocumentId: tooMuch, teamId }),
      /would total 173.72, more than its 170.57/,
    );
  });

  test("§5b.1: partially deductible VAT splits between 411000 and the cost", async () => {
    const carDoc = await makeDoc({
      number: "CAR-1",
      kind: "invoice",
      supplier: "Laadpaal bv",
      vat: "BE0111111111",
      lines: [{ code: "611901", amount: 100, taxAmount: 21 }],
    });
    const { entryId } = await postPurchaseDocument(db, {
      purchaseDocumentId: carDoc,
      teamId,
    });
    const lines = await entryLines(entryId);
    // 50% deductible: 10,50 to VAT, the other 10,50 stays in the cost.
    expect(lines[0]).toMatchObject({ code: "411000", dr: 10.5, base: 100 });
    expect(lines[1]).toMatchObject({ code: "440000", cr: 121 });
    expect(lines[2]).toMatchObject({ code: "611901", dr: 110.5 });
  });

  test("a booked document is frozen; status stays writable", async () => {
    await expectError(
      db.query(`UPDATE purchase_documents SET amount = 1 WHERE id = $1`, [
        invoiceId,
      ]),
      /booked/,
    );
    await expectError(
      db.query(`DELETE FROM purchase_documents WHERE id = $1`, [invoiceId]),
      /booked/,
    );
    await expectError(
      db.query(
        `UPDATE purchase_document_lines SET amount = 1 WHERE purchase_document_id = $1`,
        [invoiceId],
      ),
      /booked/,
    );
    await db.query(
      `UPDATE purchase_documents SET status = 'settled' WHERE id = $1`,
      [invoiceId],
    );
    const doc = await db.query(
      `SELECT status FROM purchase_documents WHERE id = $1`,
      [invoiceId],
    );
    expect(doc.rows[0].status).toBe("settled");
  });

  test("DB constraints: only credit notes carry a credits link, amounts positive", async () => {
    await expectError(
      db.query(
        `INSERT INTO purchase_documents
           (team_id, supplier_name, document_number, kind, credits_document_id,
            issue_date, amount)
         VALUES ($1, 'X', 'K-1', 'invoice', $2, '2026-08-07', 10)`,
        [teamId, invoiceId],
      ),
      /purchase_documents_credits_kind/,
    );
    await expectError(
      db.query(
        `INSERT INTO purchase_documents
           (team_id, supplier_name, document_number, kind, issue_date, amount)
         VALUES ($1, 'X', 'K-2', 'invoice', '2026-08-07', -5)`,
        [teamId],
      ),
      /purchase_documents_amount_positive/,
    );
  });
});
