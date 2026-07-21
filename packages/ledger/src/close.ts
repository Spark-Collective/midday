/**
 * Period end (M5).
 *
 * revaluePeriod: unrealized FX on currency-locked monetary accounts (§1 rule 6).
 * The foreign-currency balance is revalued at the closing rate; the difference
 * posts against 655/755 (unrealized keys) as an entry flagged isRevaluation,
 * immediately mirrored on day 1 of the next period (auto-reversing accrual —
 * both entries stay posted; this is not a status reversal). Open foreign-
 * currency party items are NOT revalued yet — the books have never had any at
 * period end; extend when they appear.
 *
 * closePeriod: verifies the month is complete (no unposted bank transactions,
 * no unposted finalized invoices; quarter-end months remind about the VAT
 * return), then locks the fiscal period. After that, I3 blocks any posting.
 */
import type { PoolClient } from "pg";
import { cents } from "./money.js";
import { LedgerError, type LineInput, postEntry } from "./post.js";

export type RevaluationResult = {
  revalued: Array<{ accountCode: string; difference: number }>;
  entryId?: string;
  reversalEntryId?: string;
};

export async function revaluePeriod(
  client: PoolClient,
  input: {
    teamId: string;
    year: number;
    month: number;
    /** currency -> functional units per 1 unit of currency (closing rates). */
    rates: Record<string, number>;
  },
): Promise<RevaluationResult> {
  const teamRes = await client.query(
    `SELECT base_currency FROM teams WHERE id = $1`,
    [input.teamId],
  );
  const functional: string = teamRes.rows[0]?.base_currency ?? "EUR";
  const endDay = new Date(Date.UTC(input.year, input.month, 0)).getUTCDate();
  const date = `${input.year}-${String(input.month).padStart(2, "0")}-${endDay}`;

  // Currency-locked accounts: functional balance vs foreign balance x closing rate.
  const accounts = await client.query(
    `SELECT a.id, a.code, a.currency,
            COALESCE(SUM(ll.debit - ll.credit), 0) AS fn_balance,
            COALESCE(SUM(ll.amount_currency), 0) AS fc_balance
       FROM gl_accounts a
       LEFT JOIN ledger_lines ll ON ll.account_id = a.id
       LEFT JOIN journal_entries je ON je.id = ll.entry_id AND je.status = 'posted'
        AND je.date <= $2
      WHERE a.team_id = $1 AND a.currency IS NOT NULL AND a.currency <> $3
      GROUP BY a.id, a.code, a.currency`,
    [input.teamId, date, functional],
  );

  const lines: LineInput[] = [];
  const revalued: RevaluationResult["revalued"] = [];
  let netGainC = 0;
  for (const a of accounts.rows) {
    const rate = input.rates[a.currency];
    if (rate === undefined) {
      throw new LedgerError(`no closing rate for ${a.currency}`);
    }
    const targetC = Math.round(cents(a.fc_balance) * rate);
    const diffC = targetC - cents(a.fn_balance);
    if (diffC === 0) continue;
    revalued.push({ accountCode: a.code, difference: diffC / 100 });
    netGainC += diffC;
    lines.push({
      accountId: a.id,
      ...(diffC > 0 ? { debit: diffC / 100 } : { credit: -diffC / 100 }),
      currency: a.currency,
      amountCurrency: 0,
      description: `Revaluation ${a.currency} @ ${rate}`,
    });
  }
  if (lines.length === 0) return { revalued: [] };

  lines.push({
    systemKey: netGainC > 0 ? "fx_gain_unrealized" : "fx_loss_unrealized",
    ...(netGainC > 0 ? { credit: netGainC / 100 } : { debit: -netGainC / 100 }),
    description: "Unrealized exchange difference",
  });

  const entry = await postEntry(client, {
    teamId: input.teamId,
    journalCode: "800",
    date,
    narration: `FX revaluation ${input.year}-${String(input.month).padStart(2, "0")}`,
    sourceType: "revaluation",
    isRevaluation: true,
    lines,
  });

  // Auto-reversing mirror on day 1 of the next period.
  const nextY = input.month === 12 ? input.year + 1 : input.year;
  const nextM = input.month === 12 ? 1 : input.month + 1;
  const mirror = await postEntry(client, {
    teamId: input.teamId,
    journalCode: "800",
    date: `${nextY}-${String(nextM).padStart(2, "0")}-01`,
    narration: `Reversal of FX revaluation ${input.year}-${String(input.month).padStart(2, "0")}`,
    sourceType: "revaluation",
    isRevaluation: true,
    lines: lines.map((l) => ({
      ...l,
      debit: l.credit,
      credit: l.debit,
      amountCurrency:
        l.amountCurrency !== undefined ? -l.amountCurrency : undefined,
    })),
  });

  return { revalued, entryId: entry.entryId, reversalEntryId: mirror.entryId };
}

export type CloseReport = {
  closed: boolean;
  issues: string[];
};

export async function closePeriod(
  client: PoolClient,
  input: { teamId: string; year: number; month: number; force?: boolean },
): Promise<CloseReport> {
  const period = await client.query(
    `SELECT id, status FROM fiscal_periods WHERE team_id = $1 AND year = $2 AND month = $3`,
    [input.teamId, input.year, input.month],
  );
  if (period.rowCount === 0) {
    throw new LedgerError(`no fiscal period ${input.year}-${input.month}`);
  }
  if (period.rows[0].status === "closed") {
    return { closed: true, issues: [] };
  }
  const mm = String(input.month).padStart(2, "0");
  const from = `${input.year}-${mm}-01`;
  const endDay = new Date(Date.UTC(input.year, input.month, 0)).getUTCDate();
  const to = `${input.year}-${mm}-${endDay}`;
  const issues: string[] = [];

  const txns = await client.query(
    `SELECT COUNT(*)::int AS n FROM transactions t
      WHERE t.team_id = $1 AND t.status = 'posted' AND t.date BETWEEN $2 AND $3
        AND NOT EXISTS (SELECT 1 FROM journal_entries je
                         WHERE je.source_type = 'transaction' AND je.source_id = t.id
                           AND je.status = 'posted')`,
    [input.teamId, from, to],
  );
  if (txns.rows[0].n > 0) {
    issues.push(
      `${txns.rows[0].n} bank transaction(s) in ${input.year}-${mm} not posted to the ledger`,
    );
  }
  const invs = await client.query(
    `SELECT COUNT(*)::int AS n FROM invoices i
      WHERE i.team_id = $1 AND i.issue_date::date BETWEEN $2 AND $3
        AND i.status NOT IN ('draft', 'canceled', 'scheduled')
        AND i.journal_entry_id IS NULL`,
    [input.teamId, from, to],
  );
  if (invs.rows[0].n > 0) {
    issues.push(
      `${invs.rows[0].n} finalized invoice(s) in ${input.year}-${mm} not posted to the ledger`,
    );
  }
  if (input.month % 3 === 0) {
    issues.push(
      `Quarter end: generate + file the VAT return for Q${input.month / 3} before relying on the close (deadline: the 25th).`,
    );
  }

  const blocking = issues.filter((i) => !i.startsWith("Quarter end"));
  if (blocking.length > 0 && !input.force) {
    return { closed: false, issues };
  }
  await client.query(
    `UPDATE fiscal_periods SET status = 'closed' WHERE id = $1`,
    [period.rows[0].id],
  );
  return { closed: true, issues };
}
