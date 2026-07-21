/**
 * Posting engine for the native double-entry ledger.
 *
 * The database owns the hard invariants (balance, immutability, period locks —
 * see packages/db/migrations/0012_accounting_core.sql); this module owns the
 * workflow: resolve journal/period/accounts, pre-validate, insert a draft entry
 * plus lines, assign the per-journal gapless entry number under a row lock, and
 * flip the entry to posted so the triggers run their validation.
 *
 * All monetary math happens in integer cents; values reach Postgres as strings.
 */
import type { PoolClient } from "pg";

export class LedgerError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export type LineInput = {
  /** Resolve the account one of three ways. */
  accountId?: string;
  accountCode?: string;
  systemKey?: string;
  /** Functional-currency amounts (exactly one side, positive), in units. */
  debit?: number;
  credit?: number;
  /** Transaction currency; defaults to the team's functional currency. */
  currency?: string;
  /** Signed amount in the transaction currency (+debit / −credit). Required
   *  when currency differs from the functional currency. */
  amountCurrency?: number;
  /** Functional-per-unit rate used; defaults to 1 for functional-currency lines. */
  fxRate?: number;
  partyType?: "customer" | "supplier" | "employee";
  partyId?: string;
  taxCodeId?: string;
  taxBase?: number;
  vatDeductiblePctUsed?: number;
  description?: string;
  analytic?: Record<string, number>;
};

export type PostEntryInput = {
  teamId: string;
  journalCode: string;
  /** ISO date (YYYY-MM-DD). Its year/month must have an open fiscal period. */
  date: string;
  narration?: string;
  sourceType?:
    | "invoice"
    | "transaction"
    | "reconciliation"
    | "revaluation"
    | "depreciation"
    | "opening"
    | "manual";
  sourceId?: string;
  sourceVersion?: number;
  postedBy?: string;
  lines: LineInput[];
};

export type PostEntryResult = {
  entryId: string;
  entryNumber: string;
};

const toCents = (v: number): number => Math.round(v * 100);
const centsToStr = (c: number): string => (c / 100).toFixed(2);

/**
 * Post a balanced entry in one transaction. `client` must be a dedicated
 * connection (pg PoolClient) — the function runs BEGIN/COMMIT itself.
 */
export async function postEntry(
  client: PoolClient,
  input: PostEntryInput,
): Promise<PostEntryResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    throw new LedgerError(
      "invalid_date",
      `date must be YYYY-MM-DD, got '${input.date}'`,
    );
  }
  if (input.lines.length < 2) {
    throw new LedgerError("too_few_lines", "an entry needs at least 2 lines");
  }

  await client.query("BEGIN");
  try {
    // Functional currency of the team.
    const teamRes = await client.query(
      `SELECT base_currency FROM teams WHERE id = $1`,
      [input.teamId],
    );
    if (teamRes.rowCount === 0) {
      throw new LedgerError("team_not_found", `team ${input.teamId} not found`);
    }
    const functional: string = teamRes.rows[0].base_currency ?? "EUR";

    // Lock the journal row: serializes posting per journal -> gapless numbers.
    const journalRes = await client.query(
      `SELECT id, code FROM journals
        WHERE team_id = $1 AND code = $2 AND active
        FOR UPDATE`,
      [input.teamId, input.journalCode],
    );
    if (journalRes.rowCount === 0) {
      throw new LedgerError(
        "journal_not_found",
        `journal '${input.journalCode}' not found for team`,
      );
    }
    const journal = journalRes.rows[0];

    const year = Number(input.date.slice(0, 4));
    const month = Number(input.date.slice(5, 7));
    const periodRes = await client.query(
      `SELECT id FROM fiscal_periods WHERE team_id = $1 AND year = $2 AND month = $3`,
      [input.teamId, year, month],
    );
    if (periodRes.rowCount === 0) {
      throw new LedgerError(
        "period_not_found",
        `no fiscal period ${year}-${String(month).padStart(2, "0")} — seed periods first`,
      );
    }
    const periodId: string = periodRes.rows[0].id;

    // Resolve accounts referenced by code / systemKey.
    const codes = input.lines.flatMap((l) =>
      l.accountCode ? [l.accountCode] : [],
    );
    const keys = input.lines.flatMap((l) => (l.systemKey ? [l.systemKey] : []));
    const acctRes = await client.query(
      `SELECT id, code, system_key FROM gl_accounts
        WHERE team_id = $1 AND (code = ANY($2::text[]) OR system_key = ANY($3::text[]))`,
      [input.teamId, codes, keys],
    );
    const byCode = new Map<string, string>();
    const byKey = new Map<string, string>();
    for (const row of acctRes.rows) {
      byCode.set(row.code, row.id);
      if (row.system_key) byKey.set(row.system_key, row.id);
    }

    // Pre-validate lines in integer cents (the DB re-checks on post).
    let debitCents = 0;
    let creditCents = 0;
    const resolved = input.lines.map((l, i) => {
      const accountId =
        l.accountId ??
        (l.accountCode ? byCode.get(l.accountCode) : undefined) ??
        (l.systemKey ? byKey.get(l.systemKey) : undefined);
      if (!accountId) {
        throw new LedgerError(
          "account_not_found",
          `line ${i + 1}: cannot resolve account (${l.accountCode ?? l.systemKey ?? l.accountId})`,
        );
      }
      const d = toCents(l.debit ?? 0);
      const c = toCents(l.credit ?? 0);
      if (d < 0 || c < 0 || (d > 0 && c > 0) || d + c === 0) {
        throw new LedgerError(
          "invalid_line",
          `line ${i + 1}: exactly one positive side required (debit=${l.debit}, credit=${l.credit})`,
        );
      }
      debitCents += d;
      creditCents += c;

      const currency = l.currency ?? functional;
      let amountCurrencyCents: number;
      if (currency === functional) {
        amountCurrencyCents = toCents(
          l.amountCurrency ?? (d > 0 ? d / 100 : -c / 100),
        );
      } else {
        if (l.amountCurrency === undefined) {
          throw new LedgerError(
            "missing_amount_currency",
            `line ${i + 1}: amountCurrency is required for ${currency} (functional is ${functional})`,
          );
        }
        amountCurrencyCents = toCents(l.amountCurrency);
      }
      return { ...l, accountId, d, c, currency, amountCurrencyCents };
    });
    if (debitCents !== creditCents) {
      throw new LedgerError(
        "unbalanced",
        `entry does not balance: debit ${centsToStr(debitCents)} <> credit ${centsToStr(creditCents)}`,
      );
    }

    const entryRes = await client.query(
      `INSERT INTO journal_entries
         (team_id, journal_id, date, period_id, source_type, source_id, source_version, narration, posted_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        input.teamId,
        journal.id,
        input.date,
        periodId,
        input.sourceType ?? "manual",
        input.sourceId ?? null,
        input.sourceVersion ?? 1,
        input.narration ?? null,
        input.postedBy ?? null,
      ],
    );
    const entryId: string = entryRes.rows[0].id;

    for (const l of resolved) {
      await client.query(
        `INSERT INTO ledger_lines
           (team_id, entry_id, account_id, debit, credit, currency, amount_currency,
            fx_rate, party_type, party_id, tax_code_id, tax_base,
            vat_deductible_pct_used, analytic, description)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          input.teamId,
          entryId,
          l.accountId,
          centsToStr(l.d),
          centsToStr(l.c),
          l.currency,
          centsToStr(l.amountCurrencyCents),
          String(l.fxRate ?? 1),
          l.partyType ?? null,
          l.partyId ?? null,
          l.taxCodeId ?? null,
          l.taxBase !== undefined ? centsToStr(toCents(l.taxBase)) : null,
          l.vatDeductiblePctUsed !== undefined
            ? String(l.vatDeductiblePctUsed)
            : null,
          l.analytic ? JSON.stringify(l.analytic) : null,
          l.description ?? null,
        ],
      );
    }

    // Gapless per-journal sequence (safe under the journal row lock).
    const seqRes = await client.query(
      `SELECT COALESCE(MAX((regexp_match(entry_number, '(\\d+)$'))[1]::int), 0) + 1 AS next
         FROM journal_entries
        WHERE journal_id = $1 AND entry_number IS NOT NULL`,
      [journal.id],
    );
    const entryNumber = `${journal.code}-${String(seqRes.rows[0].next).padStart(5, "0")}`;

    // The flip runs the database-side validation (balance, period, ...).
    await client.query(
      `UPDATE journal_entries
          SET status = 'posted', entry_number = $2
        WHERE id = $1`,
      [entryId, entryNumber],
    );

    await client.query("COMMIT");
    return { entryId, entryNumber };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}
