/**
 * Opening balances at OPEN-ITEM granularity (S9, ERPNext's opening-invoice-tool
 * insight): the AR/AP control accounts are exploded into one line per open
 * invoice, so reconciliation and aging work from day one; every other account
 * books its trial-balance amount. The entry balances because the source trial
 * balance balances — verified in cents before posting.
 */
import type { PoolClient } from "pg";
import { cents } from "./money.js";
import { LedgerError, type LineInput, postEntry } from "./post.js";

export type TbRow = {
  code: string;
  name?: string;
  debit: number;
  credit: number;
};
export type OpenItem = {
  relation: string;
  invoice: string;
  date?: string;
  amount: number;
};

export type BuildOpeningInput = {
  tb: TbRow[];
  arItems: OpenItem[];
  apItems: OpenItem[];
  arControlCode?: string; // default 400000
  apControlCode?: string; // default 440000
};

export function buildOpeningLines(input: BuildOpeningInput): LineInput[] {
  const arCode = input.arControlCode ?? "400000";
  const apCode = input.apControlCode ?? "440000";
  const lines: LineInput[] = [];
  let arControlCents = 0;
  let apControlCents = 0;

  for (const row of input.tb) {
    const d = cents(row.debit);
    const c = cents(row.credit);
    if (d === 0 && c === 0) continue;
    if (d > 0 && c > 0) {
      throw new LedgerError(`TB row ${row.code} carries both debit and credit`);
    }
    if (row.code === arCode) {
      arControlCents = d - c;
      continue; // exploded into open items below
    }
    if (row.code === apCode) {
      apControlCents = c - d;
      continue;
    }
    lines.push({
      accountCode: row.code,
      ...(d > 0 ? { debit: d / 100 } : { credit: c / 100 }),
      description: `Opening balance${row.name ? ` — ${row.name}` : ""}`,
    });
  }

  const arSum = input.arItems.reduce((s, it) => s + cents(it.amount), 0);
  if (arSum !== arControlCents) {
    throw new LedgerError(
      `open AR items (${(arSum / 100).toFixed(2)}) != TB ${arCode} (${(arControlCents / 100).toFixed(2)})`,
    );
  }
  const apSum = input.apItems.reduce((s, it) => s + cents(it.amount), 0);
  if (apSum !== apControlCents) {
    throw new LedgerError(
      `open AP items (${(apSum / 100).toFixed(2)}) != TB ${apCode} (${(apControlCents / 100).toFixed(2)})`,
    );
  }

  for (const it of input.arItems) {
    lines.push({
      accountCode: arCode,
      debit: it.amount,
      // No Midday customer id at migration time: the open item is identified by
      // its description (relation + invoice number) until linked in M2.
      description: `Open AR ${it.invoice} — ${it.relation}${it.date ? ` (${it.date})` : ""}`,
    });
  }
  for (const it of input.apItems) {
    lines.push({
      accountCode: apCode,
      credit: it.amount,
      description: `Open AP ${it.invoice} — ${it.relation}${it.date ? ` (${it.date})` : ""}`,
    });
  }
  return lines;
}

export async function postOpening(
  client: PoolClient,
  input: {
    teamId: string;
    date: string;
    lines: LineInput[];
    journalCode?: string;
  },
): Promise<{ entryId: string; entryNumber: string }> {
  const existing = await client.query(
    `SELECT id FROM journal_entries
      WHERE team_id = $1 AND source_type = 'opening' AND status = 'posted'`,
    [input.teamId],
  );
  if ((existing.rowCount ?? 0) > 0) {
    throw new LedgerError(
      `team already has a posted opening entry (${existing.rows[0].id})`,
    );
  }
  return postEntry(client, {
    teamId: input.teamId,
    journalCode: input.journalCode ?? "800",
    date: input.date,
    narration: "Opening balances",
    sourceType: "opening",
    sourceId: crypto.randomUUID(),
    lines: input.lines,
  });
}
