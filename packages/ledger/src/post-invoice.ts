/**
 * Post a Midday invoice (or credit note) into the sales journal.
 *
 *   invoice:      Dr trade_debtors (total)  / Cr sales_revenue (base) + Cr vat_payable (VAT)
 *   credit note:  the exact mirror (S7) — never a negative invoice posting.
 *
 * Foreign-currency invoices post dual-amount lines: functional debit/credit at
 * the latest exchange rate, original amounts in amountCurrency (plan §1). The
 * functional base is derived as total − VAT after rounding so the entry always
 * balances to the cent.
 */
import type { PoolClient } from "pg";
import { cents } from "./money.js";
import { LedgerError, type LineInput, postEntry } from "./post.js";

export type PostInvoiceInput = {
  invoiceId: string;
  /** Tax code (e.g. "V21"). Auto-matched by rate when VAT > 0; required for
   *  0%-VAT invoices where intra-EU vs export cannot be inferred. */
  taxCode?: string;
  /** Sales journal code, default "700". */
  journalCode?: string;
};

const NON_POSTABLE = new Set(["draft", "canceled", "scheduled"]);

export async function postInvoice(
  client: PoolClient,
  input: PostInvoiceInput,
): Promise<{ entryId: string; entryNumber: string }> {
  const res = await client.query(
    `SELECT id, team_id, customer_id, customer_name, invoice_number, amount, vat,
            currency, issue_date::date::text AS issue_date, status, invoice_type, journal_entry_id
       FROM invoices WHERE id = $1`,
    [input.invoiceId],
  );
  if (res.rowCount === 0) {
    throw new LedgerError(`invoice ${input.invoiceId} not found`);
  }
  const inv = res.rows[0];
  if (NON_POSTABLE.has(inv.status)) {
    throw new LedgerError(`invoice status '${inv.status}' does not post`);
  }
  if (inv.journal_entry_id) {
    throw new LedgerError(`invoice already posted (${inv.journal_entry_id})`);
  }
  if (!inv.issue_date) {
    throw new LedgerError("invoice has no issue date");
  }
  if (inv.amount === null || inv.amount === undefined) {
    throw new LedgerError("invoice has no amount");
  }

  const teamRes = await client.query(
    `SELECT base_currency FROM teams WHERE id = $1`,
    [inv.team_id],
  );
  const functional: string = teamRes.rows[0]?.base_currency ?? "EUR";
  const currency: string = inv.currency ?? functional;

  const total = Number(inv.amount);
  const vat = Number(inv.vat ?? 0);
  const base = total - vat;
  if (total <= 0 || base < 0) {
    throw new LedgerError(`total ${total} / vat ${vat} do not post`);
  }

  // Functional-currency conversion (identity for same-currency invoices).
  let fxRate = 1;
  if (currency !== functional) {
    const rateRes = await client.query(
      `SELECT rate FROM exchange_rates
        WHERE base = $1 AND target = $2 ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
      [currency, functional],
    );
    if (rateRes.rowCount === 0) {
      throw new LedgerError(
        `no exchange rate ${currency}->${functional} — sync exchange_rates first`,
      );
    }
    fxRate = Number(rateRes.rows[0].rate);
  }
  // Round total and VAT independently, derive base: guarantees balance.
  const fnTotal = cents(total * fxRate) / 100;
  const fnVat = cents(vat * fxRate) / 100;
  const fnBase = fnTotal - fnVat;

  // Resolve the tax code.
  let taxCodeId: string | null = null;
  if (input.taxCode) {
    const t = await client.query(
      `SELECT id FROM tax_codes WHERE team_id = $1 AND code = $2 AND active`,
      [inv.team_id, input.taxCode],
    );
    if (t.rowCount === 0) {
      throw new LedgerError(`tax code '${input.taxCode}' not found`);
    }
    taxCodeId = t.rows[0].id;
  } else if (vat > 0 && base > 0) {
    const impliedRate = (vat / base) * 100;
    const t = await client.query(
      `SELECT id, rate FROM tax_codes
        WHERE team_id = $1 AND active AND code LIKE 'V%'
          AND kind IN ('standard', 'reduced')
        ORDER BY ABS(rate - $2) ASC LIMIT 1`,
      [inv.team_id, impliedRate.toFixed(2)],
    );
    const match = t.rows[0];
    if (!match || Math.abs(Number(match.rate) - impliedRate) > 0.6) {
      throw new LedgerError(
        `cannot match a sales tax code for implied rate ${impliedRate.toFixed(2)}% — pass taxCode`,
      );
    }
    taxCodeId = match.id;
  }
  // vat === 0 without an explicit code: posts without grids (intra-EU vs export
  // is not inferable); M3's return generator flags unmapped zero-rated sales.

  const isCreditNote = inv.invoice_type === "credit_note";
  const dr = (v: number): Pick<LineInput, "debit" | "credit"> =>
    isCreditNote ? { credit: v } : { debit: v };
  const cr = (v: number): Pick<LineInput, "debit" | "credit"> =>
    isCreditNote ? { debit: v } : { credit: v };
  const sign = isCreditNote ? -1 : 1;

  const lines: LineInput[] = [
    {
      systemKey: "trade_debtors",
      ...dr(fnTotal),
      currency,
      amountCurrency: sign * total,
      fxRate,
      ...(inv.customer_id
        ? { partyType: "customer" as const, partyId: inv.customer_id }
        : {}),
      description: `${isCreditNote ? "CN" : "Invoice"} ${inv.invoice_number ?? inv.id}${
        inv.customer_name ? ` — ${inv.customer_name}` : ""
      }`,
    },
    {
      systemKey: "sales_revenue",
      ...cr(fnBase),
      currency,
      amountCurrency: -sign * base,
      fxRate,
      ...(taxCodeId ? { taxCodeId, taxBase: fnBase } : {}),
      description: inv.invoice_number ?? undefined,
    },
  ];
  if (fnVat > 0) {
    lines.push({
      systemKey: "vat_payable",
      ...cr(fnVat),
      currency,
      amountCurrency: -sign * vat,
      fxRate,
      ...(taxCodeId ? { taxCodeId, taxBase: fnBase } : {}),
      description: inv.invoice_number ?? undefined,
    });
  }

  const posted = await postEntry(client, {
    teamId: inv.team_id,
    journalCode: input.journalCode ?? "700",
    date: String(inv.issue_date).slice(0, 10),
    narration:
      `${isCreditNote ? "Credit note" : "Sales invoice"} ${inv.invoice_number ?? ""}`.trim(),
    sourceType: "invoice",
    sourceId: inv.id,
    lines,
  });

  await client.query(
    `UPDATE invoices SET journal_entry_id = $2 WHERE id = $1`,
    [inv.id, posted.entryId],
  );
  return posted;
}
