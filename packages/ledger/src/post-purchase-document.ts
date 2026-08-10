/**
 * Post a purchase document (M12): an incoming supplier invoice or credit
 * note, booked as an open item on the supplier payables account.
 *
 *   invoice:      Dr cost lines (+ Dr deductible VAT)  /  Cr trade_creditors
 *   credit_note:  the exact mirror
 *
 * The credit note is the same code path with every side flipped (the ERPNext
 * lesson: no CN-specific posting rules exist, direction does the work).
 * Credit-side tax-coded lines land in VAT grids 85/63; debit-side in 82/59.
 *
 * VAT-deductibility split (§5b.1, same rule as postTransaction): the
 * deductible fraction of each line's VAT (per the cost account's
 * vat_deductible_pct, default 100) posts to vat_deductible; the
 * non-deductible remainder stays in the cost.
 *
 * Guards learned from ERPNext (sales_and_purchase_return.py):
 *   - a linked credit note must match its invoice's supplier and currency
 *   - the sum of credit notes against one invoice cannot exceed it
 *
 * Idempotent through the same partial unique source index every document
 * uses, plus the document's own journal_entry_id pointer. Booked documents
 * are frozen by the DB trigger; correct by reversing the entry.
 */
import type { PoolClient } from "pg";
import { cents } from "./money.js";
import { LedgerError, type LineInput, postEntry } from "./post.js";

export type PostPurchaseDocumentInput = {
  purchaseDocumentId: string;
  teamId?: string;
  /** Purchases journal, default "600". */
  journalCode?: string;
};

export async function postPurchaseDocument(
  client: PoolClient,
  input: PostPurchaseDocumentInput,
): Promise<{ entryId: string; entryNumber: string }> {
  const res = await client.query(
    `SELECT d.id, d.team_id, d.supplier_name, d.supplier_vat,
            d.document_number, d.kind, d.credits_document_id,
            d.issue_date::text AS issue_date, d.currency, d.amount,
            d.tax_amount, d.status, d.journal_entry_id
       FROM purchase_documents d
      WHERE d.id = $1 AND ($2::uuid IS NULL OR d.team_id = $2)`,
    [input.purchaseDocumentId, input.teamId ?? null],
  );
  if (res.rowCount === 0) {
    throw new LedgerError(
      `purchase document ${input.purchaseDocumentId} not found`,
    );
  }
  const doc = res.rows[0];

  if (doc.journal_entry_id) {
    throw new LedgerError(
      `purchase document ${doc.document_number} already posted (${doc.journal_entry_id})`,
    );
  }

  const isCreditNote = doc.kind === "credit_note";

  if (doc.credits_document_id) {
    const ref = await client.query(
      `SELECT supplier_name, supplier_vat, document_number, kind, currency,
              amount
         FROM purchase_documents
        WHERE id = $1 AND team_id = $2`,
      [doc.credits_document_id, doc.team_id],
    );
    if (ref.rowCount === 0) {
      throw new LedgerError(
        `credit note ${doc.document_number} references an unknown document`,
      );
    }
    const inv = ref.rows[0];
    if (inv.kind !== "invoice") {
      throw new LedgerError(
        `credit note ${doc.document_number} must credit an invoice, not a ${inv.kind}`,
      );
    }
    const sameSupplier =
      doc.supplier_vat && inv.supplier_vat
        ? doc.supplier_vat === inv.supplier_vat
        : doc.supplier_name === inv.supplier_name;
    if (!sameSupplier) {
      throw new LedgerError(
        `credit note ${doc.document_number} (${doc.supplier_name}) does not match the supplier of invoice ${inv.document_number} (${inv.supplier_name})`,
      );
    }
    if (doc.currency !== inv.currency) {
      throw new LedgerError(
        `credit note ${doc.document_number} is in ${doc.currency} but invoice ${inv.document_number} is in ${inv.currency}`,
      );
    }
    // The sum of credit notes against one invoice cannot exceed it.
    const prior = await client.query(
      `SELECT COALESCE(SUM(amount), 0) AS credited
         FROM purchase_documents
        WHERE credits_document_id = $1 AND journal_entry_id IS NOT NULL`,
      [doc.credits_document_id],
    );
    const credited =
      cents(Number(prior.rows[0].credited)) + cents(Number(doc.amount));
    if (credited > cents(Number(inv.amount)) + 1) {
      throw new LedgerError(
        `credit notes against invoice ${inv.document_number} would total ${(credited / 100).toFixed(2)}, more than its ${Number(inv.amount).toFixed(2)}`,
      );
    }
  }

  const linesRes = await client.query(
    `SELECT l.description, l.gl_account_code, l.amount, l.tax_code,
            l.tax_amount, a.id AS account_id, a.vat_deductible_pct,
            tc.id AS tax_code_id
       FROM purchase_document_lines l
       LEFT JOIN gl_accounts a
         ON a.team_id = l.team_id AND a.code = l.gl_account_code
       LEFT JOIN tax_codes tc
         ON tc.team_id = l.team_id AND tc.code = l.tax_code
      WHERE l.purchase_document_id = $1
      ORDER BY l.position, l.id`,
    [doc.id],
  );
  if (linesRes.rowCount === 0) {
    throw new LedgerError(
      `purchase document ${doc.document_number} has no lines`,
    );
  }

  const unknownAccounts = linesRes.rows
    .filter((l) => !l.account_id)
    .map((l) => l.gl_account_code);
  if (unknownAccounts.length > 0) {
    throw new LedgerError(
      `unknown account code(s) on purchase document ${doc.document_number}: ${[...new Set(unknownAccounts)].join(", ")}`,
    );
  }
  const unknownTax = linesRes.rows
    .filter((l) => l.tax_code && !l.tax_code_id)
    .map((l) => l.tax_code);
  if (unknownTax.length > 0) {
    throw new LedgerError(
      `unknown tax code(s) on purchase document ${doc.document_number}: ${[...new Set(unknownTax)].join(", ")}`,
    );
  }

  // The document's direction decides which side everything posts on.
  const costSide = (v: number): Pick<LineInput, "debit" | "credit"> =>
    isCreditNote ? { credit: v } : { debit: v };
  const payableSide = (v: number): Pick<LineInput, "debit" | "credit"> =>
    isCreditNote ? { debit: v } : { credit: v };

  const lines: LineInput[] = [];
  let sumNet = 0;
  let sumTax = 0;
  for (const l of linesRes.rows) {
    const net = Number(l.amount);
    const tax = Number(l.tax_amount);
    sumNet += cents(net);
    sumTax += cents(tax);

    // §5b.1: deductible fraction to vat_deductible, remainder into the cost.
    const pct =
      l.vat_deductible_pct !== null ? Number(l.vat_deductible_pct) : 100;
    const deductible = tax > 0 ? cents(tax * (pct / 100)) / 100 : 0;
    const cost = net + tax - deductible;

    lines.push({
      accountId: l.account_id,
      ...costSide(cost),
      taxCodeId: l.tax_code_id ?? undefined,
      description: `${doc.supplier_name} ${doc.document_number} - ${l.description}`,
    });
    if (deductible > 0) {
      lines.push({
        systemKey: "vat_deductible",
        ...costSide(deductible),
        taxCodeId: l.tax_code_id ?? undefined,
        taxBase: net,
        vatDeductiblePctUsed: pct,
        description: `${doc.supplier_name} ${doc.document_number} - btw`,
      });
    }
  }

  if (sumNet + sumTax !== cents(Number(doc.amount))) {
    throw new LedgerError(
      `purchase document ${doc.document_number}: lines sum to ${((sumNet + sumTax) / 100).toFixed(2)} but total is ${Number(doc.amount).toFixed(2)}`,
    );
  }
  if (sumTax !== cents(Number(doc.tax_amount))) {
    throw new LedgerError(
      `purchase document ${doc.document_number}: line VAT sums to ${(sumTax / 100).toFixed(2)} but tax_amount is ${Number(doc.tax_amount).toFixed(2)}`,
    );
  }

  // No partyType: ledger_lines_party_pair demands a party_id with it, and
  // suppliers have no entity table; the description carries the identity.
  lines.push({
    systemKey: "trade_creditors",
    ...payableSide(Number(doc.amount)),
    description: `${doc.supplier_name} ${doc.document_number}`,
  });

  const label = isCreditNote ? "creditnota" : "factuur";
  const entry = await postEntry(client, {
    teamId: doc.team_id,
    journalCode: input.journalCode ?? "600",
    date: doc.issue_date,
    narration: `${doc.supplier_name} ${label} ${doc.document_number}`,
    sourceType: "manual",
    sourceId: doc.id,
    lines,
  });

  await client.query(
    `UPDATE purchase_documents
        SET journal_entry_id = $2, status = 'posted', updated_at = now()
      WHERE id = $1`,
    [doc.id, entry.entryId],
  );

  return entry;
}
