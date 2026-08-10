/**
 * M12b acceptance: open supplier items + one-click settlement. The Combell
 * shape end to end: invoice 170,57 and creditnota 113,72 leave a net 56,85
 * open; the matching bank payment books to 440000 (never a cost account) and
 * the whole set reconciles to zero, after which the open-items view is empty
 * and both documents read 'settled'.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Pool, type PoolClient } from "pg";
import { postPurchaseDocument } from "../src/post-purchase-document.js";
import {
  getOpenSupplierItems,
  settlePurchaseDocuments,
} from "../src/purchase-open-items.js";
import { seedBelgianLedger } from "../src/seed.js";
import { expectError, initTestDb, TEST_DB_URL } from "./helpers/setup.js";

const pool = new Pool({ connectionString: TEST_DB_URL });
let db: PoolClient;
let teamId: string;
let bankAccountId: string;
let invoiceId: string;
let creditNoteId: string;
let paymentTxnId: string;

async function makeDoc(opts: {
  number: string;
  kind: "invoice" | "credit_note";
  supplier?: string;
  credits?: string | null;
  net: number;
  tax: number;
}): Promise<string> {
  const res = await db.query(
    `INSERT INTO purchase_documents
       (team_id, supplier_name, supplier_vat, document_number, kind,
        credits_document_id, issue_date, amount, tax_amount)
     VALUES ($1, $2, 'BE0541977701', $3, $4, $5, '2026-08-07', $6, $7)
     RETURNING id`,
    [
      teamId,
      opts.supplier ?? "Combell nv",
      opts.number,
      opts.kind,
      opts.credits ?? null,
      opts.net + opts.tax,
      opts.tax,
    ],
  );
  const id = res.rows[0].id;
  await db.query(
    `INSERT INTO purchase_document_lines
       (purchase_document_id, team_id, position, description,
        gl_account_code, amount, tax_code, tax_amount)
     VALUES ($1, $2, 0, 'hosting', '611010', $3, 'P21', $4)`,
    [id, teamId, opts.net, opts.tax],
  );
  return id;
}

async function makeTxn(amount: number, name: string): Promise<string> {
  const res = await db.query(
    `INSERT INTO transactions (team_id, date, name, amount, currency, bank_account_id)
     VALUES ($1, '2026-08-10', $2, $3, 'EUR', $4) RETURNING id`,
    [teamId, name, amount, bankAccountId],
  );
  return res.rows[0].id;
}

beforeAll(async () => {
  db = await pool.connect();
  teamId = await initTestDb(db);
  await db.query("BEGIN");
  await seedBelgianLedger(db, { teamId, years: [2026] });
  await db.query("COMMIT");
  // bank fixture, as in M3
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
    `INSERT INTO gl_accounts (team_id, code, name, type)
     VALUES ($1, '611010', 'Computerbenodigdheden', 'expense')
     ON CONFLICT (team_id, code) DO NOTHING`,
    [teamId],
  );

  invoiceId = await makeDoc({ number: "260807125", kind: "invoice", net: 140.97, tax: 29.6 });
  await postPurchaseDocument(db, { purchaseDocumentId: invoiceId, teamId });
  creditNoteId = await makeDoc({ number: "260807528", kind: "credit_note", credits: invoiceId, net: 93.98, tax: 19.74 });
  await postPurchaseDocument(db, { purchaseDocumentId: creditNoteId, teamId });
  paymentTxnId = await makeTxn(-56.85, "COMBELL NV netto");
});

afterAll(async () => {
  db?.release();
  await pool.end();
});

describe("open supplier items + settlement (M12b)", () => {
  test("open items: one Combell group, net 56,85, the payment surfaces as candidate", async () => {
    const groups = await getOpenSupplierItems(db, { teamId });
    expect(groups).toHaveLength(1);
    const g = groups[0]!;
    expect(g.supplier).toBe("Combell nv");
    expect(g.net).toBe(56.85);
    expect(g.documents).toHaveLength(2);
    expect(g.documents.map((d) => d.open).sort()).toEqual([113.72, 170.57]);
    expect(g.candidates.map((c) => c.id)).toContain(paymentTxnId);
  });

  test("guards: wrong amount, mixed suppliers, unposted documents", async () => {
    const wrongTxn = await makeTxn(-50, "COMBELL wrong amount");
    await expectError(
      settlePurchaseDocuments(db, {
        teamId,
        transactionId: wrongTxn,
        documentIds: [invoiceId, creditNoteId],
      }),
      /payment is -50.00 but the open net is 56.85/,
    );

    const otherSupplier = await makeDoc({
      number: "X-1",
      kind: "invoice",
      supplier: "Somebody Else bv",
      net: 10,
      tax: 2.1,
    });
    await postPurchaseDocument(db, { purchaseDocumentId: otherSupplier, teamId });
    await expectError(
      settlePurchaseDocuments(db, {
        teamId,
        transactionId: paymentTxnId,
        documentIds: [invoiceId, otherSupplier],
      }),
      /one settlement, one supplier/,
    );

    const draft = await makeDoc({ number: "D-1", kind: "invoice", net: 5, tax: 1.05 });
    await expectError(
      settlePurchaseDocuments(db, {
        teamId,
        transactionId: paymentTxnId,
        documentIds: [invoiceId, draft],
      }),
      /missing or unposted/,
    );
  });

  test("a transaction already booked to a cost account is refused", async () => {
    // Book a same-amount transaction to a cost account via a category.
    await db.query(
      `INSERT INTO transaction_categories (team_id, slug, name, gl_account_id)
       SELECT $1, 'software', 'Software', id FROM gl_accounts
        WHERE team_id = $1 AND code = '611010'`,
      [teamId],
    );
    const costTxn = await db.query(
      `INSERT INTO transactions (team_id, date, name, amount, currency, bank_account_id, category_slug)
       VALUES ($1, '2026-08-10', 'COMBELL booked to cost', -56.85, 'EUR', $2, 'software') RETURNING id`,
      [teamId, bankAccountId],
    );
    const { postTransaction } = await import("../src/post-transaction.js");
    await postTransaction(db, { transactionId: costTxn.rows[0].id, teamId });
    await expectError(
      settlePurchaseDocuments(db, {
        teamId,
        transactionId: costTxn.rows[0].id,
        documentIds: [invoiceId, creditNoteId],
      }),
      /not to trade creditors; reverse/,
    );
  });

  test("settle: payment books to 440000, everything reconciles, documents read settled", async () => {
    const result = await settlePurchaseDocuments(db, {
      teamId,
      transactionId: paymentTxnId,
      documentIds: [invoiceId, creditNoteId],
    });
    expect(result.allocated).toBeGreaterThan(0);

    const lines = await db.query(
      `SELECT a.code, ll.debit::float8 AS dr, ll.credit::float8 AS cr
         FROM ledger_lines ll JOIN gl_accounts a ON a.id = ll.account_id
        WHERE ll.entry_id = $1 ORDER BY a.code`,
      [result.entryId],
    );
    expect(lines.rows[0]).toMatchObject({ code: "440000", dr: 56.85, cr: 0 });
    expect(lines.rows[1]).toMatchObject({ code: "550001", dr: 0, cr: 56.85 });

    const docs = await db.query(
      `SELECT status FROM purchase_documents WHERE id IN ($1, $2)`,
      [invoiceId, creditNoteId],
    );
    expect(docs.rows.every((d) => d.status === "settled")).toBe(true);

    const groups = await getOpenSupplierItems(db, { teamId });
    expect(groups.find((g) => g.supplier === "Combell nv")).toBeUndefined();
  });

  test("settling again is refused: nothing left to pay", async () => {
    const again = await makeTxn(-56.85, "COMBELL again");
    await expectError(
      settlePurchaseDocuments(db, {
        teamId,
        transactionId: again,
        documentIds: [invoiceId, creditNoteId],
      }),
      /nothing left to pay/,
    );
  });
});
