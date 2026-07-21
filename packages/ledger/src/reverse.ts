/**
 * Reversal: the ONLY way to correct a posted entry (I2). Posts a mirror entry
 * (debit<->credit, negated amountCurrency, same accounts/currency/rate/party/
 * tax fields) in the same journal, marks the original 'reversed', and clears
 * any invoice back-pointer so the document can re-post (a fresh version).
 */
import type { PoolClient } from "pg";
import { LedgerError, type LineInput, postEntry } from "./post.js";

export type ReverseEntryInput = {
  teamId: string;
  entryId: string;
  /** Date of the reversal entry; defaults to the original entry's date. */
  date?: string;
  narration?: string;
};

export async function reverseEntry(
  client: PoolClient,
  input: ReverseEntryInput,
): Promise<{ entryId: string; entryNumber: string }> {
  await client.query("BEGIN");
  try {
    const entryRes = await client.query(
      `SELECT je.id, je.status, je.date::text AS date, je.narration, j.code AS journal_code
         FROM journal_entries je JOIN journals j ON j.id = je.journal_id
        WHERE je.team_id = $1 AND je.id = $2
        FOR UPDATE OF je`,
      [input.teamId, input.entryId],
    );
    if (entryRes.rowCount === 0) {
      throw new LedgerError(
        "entry_not_found",
        `entry ${input.entryId} not found`,
      );
    }
    const entry = entryRes.rows[0];
    if (entry.status !== "posted") {
      throw new LedgerError(
        "not_posted",
        `only posted entries reverse (status: ${entry.status})`,
      );
    }
    const existing = await client.query(
      `SELECT id FROM journal_entries
        WHERE reverses_entry_id = $1 AND status = 'posted'`,
      [input.entryId],
    );
    if ((existing.rowCount ?? 0) > 0) {
      throw new LedgerError(
        "already_reversed",
        `entry already has a posted reversal (${existing.rows[0].id})`,
      );
    }

    const linesRes = await client.query(
      `SELECT account_id, debit, credit, currency, amount_currency, fx_rate,
              party_type, party_id, tax_code_id, tax_base,
              vat_deductible_pct_used, description
         FROM ledger_lines WHERE entry_id = $1`,
      [input.entryId],
    );
    const mirrored: LineInput[] = linesRes.rows.map((l) => ({
      accountId: l.account_id,
      ...(Number(l.debit) > 0
        ? { credit: Number(l.debit) }
        : { debit: Number(l.credit) }),
      currency: l.currency,
      amountCurrency: -Number(l.amount_currency),
      fxRate: Number(l.fx_rate),
      ...(l.party_type && l.party_id
        ? {
            partyType: l.party_type as "customer" | "supplier" | "employee",
            partyId: l.party_id,
          }
        : {}),
      ...(l.tax_code_id ? { taxCodeId: l.tax_code_id } : {}),
      ...(l.tax_base !== null ? { taxBase: Number(l.tax_base) } : {}),
      ...(l.vat_deductible_pct_used !== null
        ? { vatDeductiblePctUsed: Number(l.vat_deductible_pct_used) }
        : {}),
      description: l.description ? `Reversal: ${l.description}` : "Reversal",
    }));

    const posted = await postEntry(client, {
      teamId: input.teamId,
      journalCode: entry.journal_code,
      date: input.date ?? entry.date,
      narration:
        input.narration ??
        `Reversal of ${entry.narration ?? input.entryId}`.slice(0, 500),
      sourceType: "manual",
      reversesEntryId: input.entryId,
      manageTransaction: false,
      lines: mirrored,
    });

    // The one legal mutation of a posted entry (I2).
    await client.query(
      `UPDATE journal_entries SET status = 'reversed' WHERE id = $1`,
      [input.entryId],
    );
    // Free any document pointer so a corrected version can post again.
    await client.query(
      `UPDATE invoices SET journal_entry_id = NULL WHERE journal_entry_id = $1`,
      [input.entryId],
    );

    await client.query("COMMIT");
    return posted;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}
