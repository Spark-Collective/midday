/**
 * Read functions for the accounting UI (M4). Thin, read-only queries — safe on
 * a plain Pool (no transactions), hence the minimal LedgerDb interface.
 */
import type { LedgerDb } from "./post.js";

export type TrialBalanceRow = {
  accountId: string;
  code: string;
  name: string;
  type: string;
  debit: number;
  credit: number;
  balance: number;
};

/** Trial balance, optionally date-bounded (the view is all-time). */
export async function getTrialBalance(
  client: LedgerDb,
  input: { teamId: string; from?: string; to?: string },
): Promise<TrialBalanceRow[]> {
  const r = await client.query(
    `SELECT a.id AS account_id, a.code, a.name, a.type,
            SUM(ll.debit)::float8 AS debit,
            SUM(ll.credit)::float8 AS credit,
            SUM(ll.debit - ll.credit)::float8 AS balance
       FROM ledger_lines ll
       JOIN journal_entries je ON je.id = ll.entry_id AND je.status = 'posted'
       JOIN gl_accounts a ON a.id = ll.account_id
      WHERE ll.team_id = $1
        AND je.date >= COALESCE($2::date, '0001-01-01')
        AND je.date <= COALESCE($3::date, '9999-12-31')
      GROUP BY a.id, a.code, a.name, a.type
      ORDER BY a.code`,
    [input.teamId, input.from ?? null, input.to ?? null],
  );
  return r.rows.map((row) => ({
    accountId: row.account_id,
    code: row.code,
    name: row.name,
    type: row.type,
    debit: row.debit,
    credit: row.credit,
    balance: row.balance,
  }));
}

export type GeneralLedgerRow = {
  date: string;
  entryNumber: string | null;
  journalCode: string;
  accountCode: string;
  accountName: string;
  debit: number;
  credit: number;
  currency: string;
  amountCurrency: number;
  description: string | null;
  entryId: string;
};

export async function getGeneralLedger(
  client: LedgerDb,
  input: {
    teamId: string;
    accountCode?: string;
    from?: string;
    to?: string;
    limit?: number;
  },
): Promise<GeneralLedgerRow[]> {
  const r = await client.query(
    `SELECT date::text AS date, entry_number, journal_code, account_code,
            account_name, debit::float8 AS debit, credit::float8 AS credit,
            currency, amount_currency::float8 AS amount_currency, description, entry_id
       FROM v_general_ledger
      WHERE team_id = $1
        AND ($2::text IS NULL OR account_code = $2)
        AND date >= COALESCE($3::date, '0001-01-01')
        AND date <= COALESCE($4::date, '9999-12-31')
      ORDER BY date DESC, entry_number DESC NULLS LAST
      LIMIT $5`,
    [
      input.teamId,
      input.accountCode ?? null,
      input.from ?? null,
      input.to ?? null,
      input.limit ?? 100,
    ],
  );
  return r.rows.map((row) => ({
    date: row.date,
    entryNumber: row.entry_number,
    journalCode: row.journal_code,
    accountCode: row.account_code,
    accountName: row.account_name,
    debit: row.debit,
    credit: row.credit,
    currency: row.currency,
    amountCurrency: row.amount_currency,
    description: row.description,
    entryId: row.entry_id,
  }));
}

export type OpenItemRow = {
  lineId: string;
  accountCode: string;
  systemKey: string | null;
  partyType: string | null;
  partyId: string | null;
  date: string;
  entryNumber: string | null;
  description: string | null;
  residual: number;
};

export async function getOpenItems(
  client: LedgerDb,
  input: { teamId: string; partyType?: "customer" | "supplier" },
): Promise<OpenItemRow[]> {
  const r = await client.query(
    `SELECT line_id, account_code, system_key, party_type, party_id,
            date::text AS date, entry_number, description, residual::float8 AS residual
       FROM v_open_items
      WHERE team_id = $1 AND ($2::text IS NULL OR party_type::text = $2)
      ORDER BY date ASC`,
    [input.teamId, input.partyType ?? null],
  );
  return r.rows.map((row) => ({
    lineId: row.line_id,
    accountCode: row.account_code,
    systemKey: row.system_key,
    partyType: row.party_type,
    partyId: row.party_id,
    date: row.date,
    entryNumber: row.entry_number,
    description: row.description,
    residual: row.residual,
  }));
}
