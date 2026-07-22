/**
 * Post a categorised Midday bank transaction into its bank/cash journal.
 *
 *   outflow (amount < 0):  Dr category account (+ Dr deductible VAT)  / Cr bank
 *   inflow  (amount > 0):  Dr bank  / Cr category account (mirror; refunds
 *                          invert naturally through the sign — S2 sweep)
 *   transfer category:     the counterpart is the internal_transfers clearing
 *                          account (580000), never P&L (S2).
 *
 * VAT-deductibility split (§5b.1): when the transaction carries taxAmount, the
 * deductible fraction (per the category account's vatDeductiblePct, default
 * 100) posts to vat_deductible; the non-deductible remainder stays in the cost.
 *
 * Multi-currency: functional amounts come from the transaction's baseAmount
 * (Midday already dual-books); the bank line carries the original currency in
 * amountCurrency. Cost/VAT lines post in functional currency (per-currency
 * netting is a soft invariant, I7).
 */
import type { PoolClient } from "pg";
import { cents } from "./money.js";
import { LedgerError, type LineInput, postEntry } from "./post.js";

export type PostTransactionInput = {
  transactionId: string;
  /** Judgment override (the bookie): book to this account instead of the
   *  category mapping, optionally with the VAT split the bank feed lacks. */
  override?: {
    accountCode: string;
    /** VAT amount in the transaction's currency (gross booking otherwise). */
    vatAmount?: number;
    /** Defaults to the account's vat_deductible_pct, else 100. */
    vatDeductiblePct?: number;
  };
};

export async function postTransaction(
  client: PoolClient,
  input: PostTransactionInput,
): Promise<{ entryId: string; entryNumber: string }> {
  const res = await client.query(
    `SELECT id, team_id, date::text AS date, name, amount, currency, bank_account_id,
            category_slug, base_amount, base_currency, tax_amount, status
       FROM transactions WHERE id = $1`,
    [input.transactionId],
  );
  if (res.rowCount === 0) {
    throw new LedgerError(`transaction ${input.transactionId} not found`);
  }
  const txn = res.rows[0];
  if (txn.status !== "posted") {
    throw new LedgerError(`transaction status '${txn.status}' does not post`);
  }
  if (!txn.category_slug && !input.override) {
    throw new LedgerError(
      "transaction has no category — categorise it first or book with an override",
    );
  }
  if (Number(txn.amount) === 0) {
    throw new LedgerError("zero-amount transaction does not post");
  }

  const teamRes = await client.query(
    `SELECT base_currency FROM teams WHERE id = $1`,
    [txn.team_id],
  );
  const functional: string = teamRes.rows[0]?.base_currency ?? "EUR";
  const currency: string = txn.currency;

  // The bank/cash journal bound to this bank account, with its GL side.
  const journalRes = await client.query(
    `SELECT code, gl_account_id FROM journals
      WHERE team_id = $1 AND bank_account_id = $2 AND type IN ('bank', 'cash') AND active`,
    [txn.team_id, txn.bank_account_id],
  );
  if (journalRes.rowCount === 0) {
    throw new LedgerError(
      `no bank/cash journal bound to bank account ${txn.bank_account_id} — bind one first`,
    );
  }
  const journal = journalRes.rows[0];
  if (!journal.gl_account_id) {
    throw new LedgerError(
      `journal '${journal.code}' has no gl_account_id (the 55x/57x account) — set it first`,
    );
  }

  // Counterpart: the category's mapped account, or the transfer clearing account.
  const isTransfer = txn.category_slug === "transfer";
  let counterAccountId: string;
  let vatPct = 100;
  if (isTransfer) {
    const t = await client.query(
      `SELECT id FROM gl_accounts WHERE team_id = $1 AND system_key = 'internal_transfers'`,
      [txn.team_id],
    );
    counterAccountId = t.rows[0]?.id;
  } else if (input.override) {
    const acc = await client.query(
      `SELECT id, vat_deductible_pct FROM gl_accounts WHERE team_id = $1 AND code = $2`,
      [txn.team_id, input.override.accountCode],
    );
    if (acc.rowCount === 0) {
      throw new LedgerError(
        `override account ${input.override.accountCode} not found`,
      );
    }
    counterAccountId = acc.rows[0].id;
    vatPct =
      input.override.vatDeductiblePct ??
      (acc.rows[0].vat_deductible_pct !== null
        ? Number(acc.rows[0].vat_deductible_pct)
        : 100);
  } else {
    const cat = await client.query(
      `SELECT tc.gl_account_id, a.vat_deductible_pct
         FROM transaction_categories tc
         LEFT JOIN gl_accounts a ON a.id = tc.gl_account_id
        WHERE tc.team_id = $1 AND tc.slug = $2`,
      [txn.team_id, txn.category_slug],
    );
    if (cat.rowCount === 0 || !cat.rows[0].gl_account_id) {
      throw new LedgerError(
        `category '${txn.category_slug}' has no gl_account_id mapping — map it first`,
      );
    }
    counterAccountId = cat.rows[0].gl_account_id;
    vatPct =
      cat.rows[0].vat_deductible_pct !== null
        ? Number(cat.rows[0].vat_deductible_pct)
        : 100;
  }

  // Functional magnitude. Midday dual-books: baseAmount is the functional value.
  const amount = Number(txn.amount); // signed, original currency
  const inflow = amount > 0;
  let fnAbsCents: number;
  if (currency === functional) {
    fnAbsCents = Math.abs(cents(amount));
  } else {
    if (txn.base_amount === null || txn.base_amount === undefined) {
      throw new LedgerError(
        `foreign-currency transaction has no base_amount (${currency} vs ${functional})`,
      );
    }
    fnAbsCents = Math.abs(cents(Number(txn.base_amount)));
  }
  const fnAbs = fnAbsCents / 100;
  const fxRate = Math.abs(fnAbs / amount);

  // VAT split (from the bank feed's tax_amount, or the bookie's override).
  let vatFn = 0;
  let deductible = 0;
  const taxSource = input.override?.vatAmount ?? txn.tax_amount;
  if (!isTransfer && taxSource) {
    const taxAbs = Math.abs(Number(taxSource));
    vatFn = cents(taxAbs * (currency === functional ? 1 : fxRate)) / 100;
    deductible = cents(vatFn * (vatPct / 100)) / 100;
  }
  const costFn = fnAbs - deductible; // base + non-deductible VAT (§5b.1)
  const taxBaseFn = fnAbs - vatFn;

  const bankSide = (v: number): Pick<LineInput, "debit" | "credit"> =>
    inflow ? { debit: v } : { credit: v };
  const counterSide = (v: number): Pick<LineInput, "debit" | "credit"> =>
    inflow ? { credit: v } : { debit: v };

  const lines: LineInput[] = [
    {
      accountId: journal.gl_account_id,
      ...bankSide(fnAbs),
      currency,
      amountCurrency:
        currency === functional ? (inflow ? fnAbs : -fnAbs) : amount,
      fxRate,
      description: txn.name,
    },
    {
      accountId: counterAccountId,
      ...counterSide(costFn),
      currency: functional,
      amountCurrency: inflow ? -costFn : costFn,
      description: txn.name,
    },
  ];
  if (deductible > 0) {
    lines.push({
      systemKey: "vat_deductible",
      ...counterSide(deductible),
      currency: functional,
      amountCurrency: inflow ? -deductible : deductible,
      vatDeductiblePctUsed: vatPct,
      taxBase: taxBaseFn,
      description: txn.name,
    });
  }

  return postEntry(client, {
    teamId: txn.team_id,
    journalCode: journal.code,
    date: String(txn.date).slice(0, 10),
    narration: txn.name,
    sourceType: "transaction",
    sourceId: txn.id,
    lines,
  });
}
