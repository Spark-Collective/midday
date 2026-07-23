/**
 * One amortization engine, two uses (S4): fixed-asset depreciation
 * (Dr 6302x / Cr 2xx9) and cost deferrals over 490000 (Dr cost / Cr 490000) —
 * the books show both as the same monthly mechanic ("Uitgesteld ..." spreads).
 *
 * The schedule is deterministic from (startDate, months, amount, residual):
 * equal monthly charges rounded to the cent, with the FINAL month absorbing the
 * rounding remainder so accumulated = amount − residual exactly.
 * postAmortization posts one entry per run covering every due item; per-item
 * idempotency is amortization_lines' (item, period) unique key, so late-
 * registered items can post into an already-run period without conflict.
 */
import type { PoolClient } from "pg";
import { cents } from "./money.js";
import { LedgerError, type LineInput, postEntry } from "./post.js";

export type RegisterAmortizationInput = {
  teamId: string;
  kind: "asset" | "deferral";
  name: string;
  chargeAccountCode: string;
  balanceAccountCode: string;
  /** Assets only: the 2xx cost account (needed for disposal). */
  assetAccountCode?: string;
  sourceRef?: string;
  startDate: string; // YYYY-MM-DD
  months: number;
  amount: number;
  residualValue?: number;
};

const monthIndex = (y: number, m: number): number => y * 12 + (m - 1);

/** Charge (in cents) for period (y, m); 0 outside the schedule window. */
export function scheduleAmountCents(
  item: {
    start_date: string;
    months: number;
    amount: number | string;
    residual_value: number | string;
  },
  year: number,
  month: number,
): number {
  const startY = Number(String(item.start_date).slice(0, 4));
  const startM = Number(String(item.start_date).slice(5, 7));
  const idx = monthIndex(year, month) - monthIndex(startY, startM);
  if (idx < 0 || idx >= item.months) return 0;
  const total = cents(item.amount) - cents(item.residual_value);
  const monthly = Math.round(total / item.months);
  // final month absorbs the rounding remainder
  return idx === item.months - 1
    ? total - monthly * (item.months - 1)
    : monthly;
}

async function accountId(
  client: PoolClient,
  teamId: string,
  code: string,
): Promise<string> {
  const r = await client.query(
    `SELECT id FROM gl_accounts WHERE team_id = $1 AND code = $2 AND active`,
    [teamId, code],
  );
  if (r.rowCount === 0) {
    throw new LedgerError(`account ${code} not found`);
  }
  return r.rows[0].id;
}

export async function registerAmortization(
  client: PoolClient,
  input: RegisterAmortizationInput,
): Promise<{ amortizationId: string }> {
  if (input.kind === "asset" && !input.assetAccountCode) {
    throw new LedgerError(
      "assets need assetAccountCode (the 2xx cost account)",
    );
  }
  const r = await client.query(
    `INSERT INTO amortizations
       (team_id, kind, name, charge_account_id, balance_account_id, asset_account_id,
        source_ref, start_date, months, amount, residual_value)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      input.teamId,
      input.kind,
      input.name,
      await accountId(client, input.teamId, input.chargeAccountCode),
      await accountId(client, input.teamId, input.balanceAccountCode),
      input.assetAccountCode
        ? await accountId(client, input.teamId, input.assetAccountCode)
        : null,
      input.sourceRef ?? null,
      input.startDate,
      input.months,
      String(input.amount),
      String(input.residualValue ?? 0),
    ],
  );
  return { amortizationId: r.rows[0].id };
}

/**
 * Post the month's amortization: one entry (journal 800) with a Dr charge /
 * Cr balance pair per due item, dated the last day of the month.
 */
export async function postAmortization(
  client: PoolClient,
  input: { teamId: string; year: number; month: number },
): Promise<
  { entryId: string; entryNumber: string; items: number } | { items: 0 }
> {
  const period = await client.query(
    `SELECT id FROM fiscal_periods WHERE team_id = $1 AND year = $2 AND month = $3`,
    [input.teamId, input.year, input.month],
  );
  if (period.rowCount === 0) {
    throw new LedgerError(`no fiscal period ${input.year}-${input.month}`);
  }
  const periodId: string = period.rows[0].id;

  const items = await client.query(
    `SELECT a.id, a.name, a.kind, a.start_date::text AS start_date, a.months,
            a.amount, a.residual_value, a.charge_account_id, a.balance_account_id
       FROM amortizations a
      WHERE a.team_id = $1 AND a.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM amortization_lines al
                         WHERE al.amortization_id = a.id AND al.period_id = $2)`,
    [input.teamId, periodId],
  );
  const due = items.rows
    .map((it) => ({
      ...it,
      dueCents: scheduleAmountCents(it, input.year, input.month),
    }))
    .filter((it) => it.dueCents > 0);
  if (due.length === 0) return { items: 0 };

  const endDay = new Date(Date.UTC(input.year, input.month, 0)).getUTCDate();
  const date = `${input.year}-${String(input.month).padStart(2, "0")}-${endDay}`;
  const lines: LineInput[] = due.flatMap((it) => [
    {
      accountId: it.charge_account_id,
      debit: it.dueCents / 100,
      description: `${it.kind === "asset" ? "Afschrijving" : "Uitgesteld"} ${it.name}`,
    },
    {
      accountId: it.balance_account_id,
      credit: it.dueCents / 100,
      description: `${it.kind === "asset" ? "Afschrijving" : "Uitgesteld"} ${it.name}`,
    },
  ]);

  // One transaction covering the entry AND the amortization_lines idempotency
  // records: a crash between them re-posted the same month (review finding).
  await client.query("BEGIN");
  let posted: { entryId: string; entryNumber: string };
  try {
    posted = await postEntry(client, {
      teamId: input.teamId,
      journalCode: "800",
      date,
      narration: `Amortization ${input.year}-${String(input.month).padStart(2, "0")}`,
      // no sourceId: a period may legitimately get a second entry when items are
      // registered later; per-item idempotency is amortization_lines' unique key.
      sourceType: "depreciation",
      manageTransaction: false,
      lines,
    });

    for (const it of due) {
      await client.query(
        `INSERT INTO amortization_lines (team_id, amortization_id, period_id, amount, entry_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          input.teamId,
          it.id,
          periodId,
          (it.dueCents / 100).toFixed(2),
          posted.entryId,
        ],
      );
      // completed when the whole depreciable base has been posted
      const done = await client.query(
        `SELECT COALESCE(SUM(amount), 0) AS posted FROM amortization_lines
          WHERE amortization_id = $1`,
        [it.id],
      );
      if (
        cents(done.rows[0].posted) >=
        cents(it.amount) - cents(it.residual_value)
      ) {
        await client.query(
          `UPDATE amortizations SET status = 'completed' WHERE id = $1`,
          [it.id],
        );
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
  return { ...posted, items: due.length };
}

/**
 * Asset disposal: derecognise cost and accumulated depreciation, book the
 * proceeds, and take the difference to 763000 (gain) / 663000 (loss).
 */
export async function disposeAsset(
  client: PoolClient,
  input: {
    teamId: string;
    amortizationId: string;
    date: string;
    proceeds?: number;
    /** Where the proceeds land (e.g. "550001" or "400000"). Required if proceeds > 0. */
    proceedsAccountCode?: string;
  },
): Promise<{ entryId: string; entryNumber: string }> {
  const r = await client.query(
    `SELECT a.*, (SELECT COALESCE(SUM(al.amount), 0) FROM amortization_lines al
                   WHERE al.amortization_id = a.id) AS accumulated
       FROM amortizations a WHERE a.team_id = $1 AND a.id = $2`,
    [input.teamId, input.amortizationId],
  );
  if (r.rowCount === 0) {
    throw new LedgerError(`amortization ${input.amortizationId} not found`);
  }
  const item = r.rows[0];
  if (item.kind !== "asset") {
    throw new LedgerError("only assets dispose; deferrals just run out");
  }
  if (item.status === "disposed") {
    throw new LedgerError("asset already disposed");
  }
  const costC = cents(item.amount);
  const accumC = cents(item.accumulated);
  const proceedsC = cents(input.proceeds ?? 0);
  if (proceedsC > 0 && !input.proceedsAccountCode) {
    throw new LedgerError("proceeds need proceedsAccountCode");
  }

  const lines: LineInput[] = [
    // out with the cost, out with the accumulated depreciation
    {
      accountId: item.asset_account_id,
      credit: costC / 100,
      description: `Disposal ${item.name}`,
    },
  ];
  if (accumC > 0) {
    lines.push({
      accountId: item.balance_account_id,
      debit: accumC / 100,
      description: `Disposal ${item.name}`,
    });
  }
  if (proceedsC > 0 && input.proceedsAccountCode) {
    lines.push({
      accountCode: input.proceedsAccountCode,
      debit: proceedsC / 100,
      description: `Disposal proceeds ${item.name}`,
    });
  }
  const resultC = proceedsC + accumC - costC; // + gain / − loss
  if (resultC > 0) {
    lines.push({
      systemKey: "asset_disposal_gain",
      credit: resultC / 100,
      description: `Meerwaarde ${item.name}`,
    });
  } else if (resultC < 0) {
    lines.push({
      systemKey: "asset_disposal_loss",
      debit: -resultC / 100,
      description: `Minderwaarde ${item.name}`,
    });
  }

  // One transaction covering the disposal entry AND the status flip: a crash
  // between them allowed a second full disposal (review finding).
  await client.query("BEGIN");
  try {
    const posted = await postEntry(client, {
      teamId: input.teamId,
      journalCode: "800",
      date: input.date,
      narration: `Disposal ${item.name}`,
      sourceType: "manual",
      manageTransaction: false,
      lines,
    });
    await client.query(
      `UPDATE amortizations SET status = 'disposed' WHERE id = $1`,
      [input.amortizationId],
    );
    await client.query("COMMIT");
    return posted;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}
