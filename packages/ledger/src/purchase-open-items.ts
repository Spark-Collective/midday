/**
 * Open supplier items + settlement (M12b).
 *
 * A posted purchase document leaves exactly one line on trade creditors
 * (440000). Its residual (amount minus allocations, the v_open_items math)
 * is what is still open: an invoice residual is money we owe, a credit-note
 * residual is money already credited back. Per supplier the net of both is
 * what a bank payment should actually move, the Combell shape:
 * invoice 170,57 − creditnota 113,72 = one payment of 56,85.
 *
 * settlePurchaseDocuments books that payment to 440000 (never a cost
 * account: the costs were booked by the documents) and reconciles the whole
 * set through plain M2 allocation. Strict by design: the transaction must
 * match the net to the cent, and a transaction already booked to a cost
 * account is refused, not repaired; reverse it first.
 */
import type { PoolClient } from "pg";
import { LedgerError } from "./post.js";
import { postTransaction } from "./post-transaction.js";
import { reconcile } from "./reconcile.js";

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export type OpenSupplierDocument = {
  id: string;
  documentNumber: string;
  kind: "invoice" | "credit_note";
  issueDate: string;
  amount: number;
  /** Still open on 440000 for this document (positive amounts). */
  open: number;
  lineId: string;
};

export type OpenSupplierGroup = {
  supplier: string;
  documents: OpenSupplierDocument[];
  /** Positive = we owe the supplier this net amount. */
  net: number;
  /** Unbooked bank transactions whose amount matches the net. */
  candidates: Array<{ id: string; date: string; name: string; amount: number }>;
};

type DocLine = {
  id: string;
  supplier_name: string;
  document_number: string;
  kind: "invoice" | "credit_note";
  issue_date: string;
  amount: number;
  status: string;
  line_id: string;
  /** Signed like v_open_items: + open debit (CN), − open credit (invoice). */
  residual: number;
};

async function openDocumentLines(
  client: PoolClient,
  teamId: string,
  documentIds?: string[],
): Promise<DocLine[]> {
  const res = await client.query(
    `SELECT d.id, d.supplier_name, d.document_number, d.kind,
            d.issue_date::text AS issue_date, d.amount::float8 AS amount,
            d.status, ll.id AS line_id,
            ((ll.debit - COALESCE(ad.s, 0)) - (ll.credit - COALESCE(ac.s, 0)))::float8
              AS residual
       FROM purchase_documents d
       JOIN journal_entries je
         ON je.id = d.journal_entry_id AND je.status = 'posted'
       JOIN ledger_lines ll ON ll.entry_id = je.id
       JOIN gl_accounts a
         ON a.id = ll.account_id AND a.system_key = 'trade_creditors'
       LEFT JOIN LATERAL (
         SELECT SUM(amount) AS s FROM reconciliation_allocations
          WHERE debit_line_id = ll.id) ad ON true
       LEFT JOIN LATERAL (
         SELECT SUM(amount) AS s FROM reconciliation_allocations
          WHERE credit_line_id = ll.id) ac ON true
      WHERE d.team_id = $1
        AND ($2::uuid[] IS NULL OR d.id = ANY($2))
      ORDER BY d.supplier_name, d.issue_date, d.document_number`,
    [teamId, documentIds ?? null],
  );
  return res.rows as DocLine[];
}

export async function getOpenSupplierItems(
  client: PoolClient,
  input: { teamId: string },
): Promise<OpenSupplierGroup[]> {
  const lines = (await openDocumentLines(client, input.teamId)).filter(
    (l) => Math.abs(l.residual) > 0.005,
  );

  const bySupplier = new Map<string, DocLine[]>();
  for (const l of lines) {
    const list = bySupplier.get(l.supplier_name) ?? [];
    list.push(l);
    bySupplier.set(l.supplier_name, list);
  }

  const groups: OpenSupplierGroup[] = [];
  for (const [supplier, docs] of bySupplier) {
    const net = r2(-docs.reduce((s, d) => s + d.residual, 0));
    const candidates =
      net > 0
        ? (
            await client.query(
              `SELECT t.id, t.date::text AS date, t.name, t.amount::float8 AS amount
                 FROM transactions t
                WHERE t.team_id = $1 AND t.status = 'posted'
                  AND ABS(COALESCE(t.base_amount, t.amount) + $2) < 0.005
                  AND NOT EXISTS (
                    SELECT 1 FROM journal_entries je
                     WHERE je.team_id = t.team_id AND je.source_id = t.id
                       AND je.status = 'posted')
                ORDER BY t.date DESC LIMIT 5`,
              [input.teamId, net],
            )
          ).rows
        : [];
    groups.push({
      supplier,
      documents: docs.map((d) => ({
        id: d.id,
        documentNumber: d.document_number,
        kind: d.kind,
        issueDate: d.issue_date,
        amount: d.amount,
        open: r2(Math.abs(d.residual)),
        lineId: d.line_id,
      })),
      net,
      candidates,
    });
  }
  return groups;
}

export type SettleInput = {
  teamId: string;
  transactionId: string;
  documentIds: string[];
};

export async function settlePurchaseDocuments(
  client: PoolClient,
  input: SettleInput,
): Promise<{
  entryId: string;
  entryNumber: string;
  reconciliationId?: string;
  allocated: number;
}> {
  if (input.documentIds.length === 0) {
    throw new LedgerError("nothing to settle: no documents given");
  }
  const docs = await openDocumentLines(
    client,
    input.teamId,
    input.documentIds,
  );
  if (docs.length !== input.documentIds.length) {
    throw new LedgerError(
      "settlement needs posted documents; at least one is missing or unposted",
    );
  }
  const suppliers = new Set(docs.map((d) => d.supplier_name));
  if (suppliers.size > 1) {
    throw new LedgerError(
      `one settlement, one supplier — got ${[...suppliers].join(" + ")}`,
    );
  }
  const net = r2(-docs.reduce((s, d) => s + d.residual, 0));
  if (net <= 0) {
    throw new LedgerError(
      `nothing left to pay on these documents (net open ${net.toFixed(2)})`,
    );
  }

  const txnRes = await client.query(
    `SELECT id, amount::float8 AS amount,
            COALESCE(base_amount, amount)::float8 AS base_amount
       FROM transactions WHERE id = $1 AND team_id = $2`,
    [input.transactionId, input.teamId],
  );
  if (txnRes.rowCount === 0) {
    throw new LedgerError(`transaction ${input.transactionId} not found`);
  }
  const txn = txnRes.rows[0];
  if (Math.abs(txn.base_amount + net) > 0.005) {
    throw new LedgerError(
      `payment is ${txn.base_amount.toFixed(2)} but the open net is ${net.toFixed(2)}; settle exactly or reconcile by hand`,
    );
  }

  // Already booked? Reuse a 440000 booking; refuse a cost booking.
  const existing = await client.query(
    `SELECT je.id, je.entry_number FROM journal_entries je
      WHERE je.team_id = $1 AND je.source_id = $2 AND je.status = 'posted'`,
    [input.teamId, input.transactionId],
  );
  let entryId: string;
  let entryNumber: string;
  if ((existing.rowCount ?? 0) > 0) {
    entryId = existing.rows[0].id;
    entryNumber = existing.rows[0].entry_number;
  } else {
    const posted = await postTransaction(client, {
      transactionId: input.transactionId,
      teamId: input.teamId,
      // The costs live on the documents; the payment only clears the payable.
      override: { accountCode: "440000", vatAmount: 0 },
    });
    entryId = posted.entryId;
    entryNumber = posted.entryNumber;
  }

  const payLine = await client.query(
    `SELECT ll.id FROM ledger_lines ll
       JOIN gl_accounts a ON a.id = ll.account_id
      WHERE ll.entry_id = $1 AND a.system_key = 'trade_creditors'`,
    [entryId],
  );
  if (payLine.rowCount === 0) {
    throw new LedgerError(
      `transaction is already booked (${entryNumber}) but not to trade creditors; reverse that entry first`,
    );
  }

  const result = await reconcile(client, {
    teamId: input.teamId,
    lineIds: [...docs.map((d) => d.line_id), payLine.rows[0].id],
  });
  if (result.status !== "full") {
    throw new LedgerError(
      `settlement did not fully allocate (residual ${result.residual.toFixed(2)})`,
    );
  }

  await client.query(
    `UPDATE purchase_documents SET status = 'settled', updated_at = now()
      WHERE team_id = $1 AND id = ANY($2)`,
    [input.teamId, input.documentIds],
  );

  return {
    entryId,
    entryNumber,
    reconciliationId: result.reconciliationId,
    allocated: result.allocated,
  };
}
