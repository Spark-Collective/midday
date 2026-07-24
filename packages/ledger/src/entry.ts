/**
 * Single-entry drill-through (M8): the full entry with per-line VAT detail
 * and the bridge to its source document — the invoice (with PDF path) or the
 * bank transaction (with receipt attachments). Read-only, plain Pool.
 */
import type { LedgerDb } from "./post.js";

export type EntryLine = {
  accountCode: string;
  accountName: string;
  debit: number;
  credit: number;
  currency: string | null;
  amountCurrency: number | null;
  taxCode: string | null;
  taxBase: number | null;
  vatDeductiblePctUsed: number | null;
  description: string | null;
  reconciled: boolean;
};

export type EntrySource =
  | {
      kind: "invoice";
      invoiceNumber: string | null;
      customerName: string | null;
      amount: number | null;
      filePath: string[] | null;
    }
  | {
      kind: "transaction";
      name: string;
      date: string;
      amount: number;
      currency: string;
      attachments: Array<{ name: string | null; path: string[] | null }>;
    }
  | null;

export type EntryDetail = {
  id: string;
  entryNumber: string | null;
  journalCode: string;
  date: string;
  narration: string | null;
  sourceType: string | null;
  status: string;
  reversesEntryId: string | null;
  lines: EntryLine[];
  source: EntrySource;
};

export async function getEntry(
  client: LedgerDb,
  input: { teamId: string; entryId: string },
): Promise<EntryDetail | null> {
  const e = await client.query(
    `SELECT je.id, je.entry_number, j.code AS journal_code, je.date::text AS date,
            je.narration, je.source_type, je.source_id, je.status,
            je.reverses_entry_id
       FROM journal_entries je
       JOIN journals j ON j.id = je.journal_id
      WHERE je.team_id = $1 AND je.id = $2`,
    [input.teamId, input.entryId],
  );
  if (e.rowCount === 0) return null;
  const entry = e.rows[0];

  const l = await client.query(
    `SELECT a.code AS account_code, a.name AS account_name,
            ll.debit::float8 AS debit, ll.credit::float8 AS credit,
            ll.currency, ll.amount_currency::float8 AS amount_currency,
            tc.code AS tax_code, ll.tax_base::float8 AS tax_base,
            ll.vat_deductible_pct_used::float8 AS vat_pct,
            ll.description, (ll.reconciliation_id IS NOT NULL) AS reconciled
       FROM ledger_lines ll
       JOIN gl_accounts a ON a.id = ll.account_id
       LEFT JOIN tax_codes tc ON tc.id = ll.tax_code_id
      WHERE ll.team_id = $1 AND ll.entry_id = $2
      ORDER BY ll.debit DESC, a.code`,
    [input.teamId, input.entryId],
  );

  let source: EntrySource = null;
  if (entry.source_type === "invoice" && entry.source_id) {
    const inv = await client.query(
      `SELECT invoice_number, customer_name, amount::float8 AS amount, file_path
         FROM invoices WHERE team_id = $1 AND id = $2`,
      [input.teamId, entry.source_id],
    );
    if (inv.rowCount) {
      source = {
        kind: "invoice",
        invoiceNumber: inv.rows[0].invoice_number,
        customerName: inv.rows[0].customer_name,
        amount: inv.rows[0].amount,
        filePath: inv.rows[0].file_path,
      };
    }
  } else if (entry.source_type === "transaction" && entry.source_id) {
    const txn = await client.query(
      `SELECT t.name, t.date::text AS date, t.amount::float8 AS amount, t.currency
         FROM transactions t WHERE t.team_id = $1 AND t.id = $2`,
      [input.teamId, entry.source_id],
    );
    if (txn.rowCount) {
      const att = await client.query(
        `SELECT name, path FROM transaction_attachments
          WHERE team_id = $1 AND transaction_id = $2`,
        [input.teamId, entry.source_id],
      );
      source = {
        kind: "transaction",
        name: txn.rows[0].name,
        date: txn.rows[0].date,
        amount: txn.rows[0].amount,
        currency: txn.rows[0].currency,
        attachments: att.rows,
      };
    }
  }

  return {
    id: entry.id,
    entryNumber: entry.entry_number,
    journalCode: entry.journal_code,
    date: entry.date,
    narration: entry.narration,
    sourceType: entry.source_type,
    status: entry.status,
    reversesEntryId: entry.reverses_entry_id,
    lines: l.rows.map((r) => ({
      accountCode: r.account_code,
      accountName: r.account_name,
      debit: r.debit,
      credit: r.credit,
      currency: r.currency,
      amountCurrency: r.amount_currency,
      taxCode: r.tax_code,
      taxBase: r.tax_base,
      vatDeductiblePctUsed: r.vat_pct,
      description: r.description,
      reconciled: r.reconciled,
    })),
    source,
  };
}
