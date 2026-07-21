/**
 * Open-item reconciliation (S6): PAIRWISE allocations between debit and credit
 * ledger lines on the same account — the Odoo partial-reconcile model. A line's
 * residual = its amount − Σ allocations, so partial payments allocate exactly.
 *
 * When the selected lines net to zero the group is closed (a reconciliations
 * row, stamped on every line). Two kinds of residual can be settled by an
 * auto-posted entry (journal 800, sourceType 'reconciliation'):
 *
 *   - realized FX (§1 rule 5, worked example B): the item is settled in its
 *     foreign currency but a functional residual remains -> 654/754.
 *   - payment differences within an explicit tolerance (S1) -> 657010/757010.
 *
 * Anything else stays partial. unallocate() undoes allocations — bookkeeping
 * metadata only, posted lines are never touched.
 */
import type { PoolClient } from "pg";
import { LedgerError, postEntry } from "./post.js";

export type ReconcileInput = {
  teamId: string;
  /** Posted ledger lines on ONE account (e.g. the open 400000 items to match). */
  lineIds: string[];
  /** Date for any residual (FX / write-off) entry; defaults to today. */
  date?: string;
  /** Max payment difference to write off automatically. Default 0: never. */
  writeOffTolerance?: number;
  journalCode?: string;
};

export type ReconcileResult = {
  status: "full" | "partial";
  reconciliationId?: string;
  allocated: number;
  residual: number;
  residualEntry?: {
    entryId: string;
    entryNumber: string;
    kind: "fx" | "write_off";
  };
};

type Line = {
  id: string;
  account_id: string;
  account_code: string;
  party_type: string | null;
  party_id: string | null;
  currency: string;
  amount_currency: number;
  debit: number;
  credit: number;
  allocated: number;
  residual: number; // signed cents: + open debit, − open credit
};

const cents = (v: number | string): number => Math.round(Number(v) * 100);

export async function reconcile(
  client: PoolClient,
  input: ReconcileInput,
): Promise<ReconcileResult> {
  if (input.lineIds.length < 2) {
    throw new LedgerError(
      "too_few_lines",
      "reconciliation needs at least 2 lines",
    );
  }
  await client.query("BEGIN");
  try {
    const res = await client.query(
      `SELECT ll.id, ll.account_id, a.code AS account_code, ll.party_type, ll.party_id,
              ll.currency, ll.amount_currency, ll.debit, ll.credit, ll.reconciliation_id,
              je.status AS entry_status,
              COALESCE((SELECT SUM(ra.amount) FROM reconciliation_allocations ra
                         WHERE ra.debit_line_id = ll.id), 0) AS alloc_debit,
              COALESCE((SELECT SUM(ra.amount) FROM reconciliation_allocations ra
                         WHERE ra.credit_line_id = ll.id), 0) AS alloc_credit
         FROM ledger_lines ll
         JOIN journal_entries je ON je.id = ll.entry_id
         JOIN gl_accounts a ON a.id = ll.account_id
        WHERE ll.team_id = $1 AND ll.id = ANY($2::uuid[])
        FOR UPDATE OF ll`,
      [input.teamId, input.lineIds],
    );
    if (res.rowCount !== input.lineIds.length) {
      throw new LedgerError(
        "lines_not_found",
        "some lines not found for this team",
      );
    }

    const lines: Line[] = res.rows.map((r) => {
      if (r.entry_status !== "posted") {
        throw new LedgerError(
          "not_posted",
          `line ${r.id} belongs to a ${r.entry_status} entry`,
        );
      }
      if (r.reconciliation_id) {
        throw new LedgerError(
          "already_reconciled",
          `line ${r.id} is already fully reconciled`,
        );
      }
      const debit = cents(r.debit);
      const credit = cents(r.credit);
      const residual =
        debit > 0
          ? debit - cents(r.alloc_debit)
          : -(credit - cents(r.alloc_credit));
      return {
        id: r.id,
        account_id: r.account_id,
        account_code: r.account_code,
        party_type: r.party_type,
        party_id: r.party_id,
        currency: r.currency,
        amount_currency: cents(r.amount_currency),
        debit,
        credit,
        allocated: debit > 0 ? cents(r.alloc_debit) : cents(r.alloc_credit),
        residual,
      };
    });

    const accountIds = new Set(lines.map((l) => l.account_id));
    if (accountIds.size !== 1) {
      throw new LedgerError(
        "mixed_accounts",
        "all lines must be on the same account",
      );
    }
    const account = lines[0];
    if (!account) throw new LedgerError("lines_not_found", "no lines");

    const teamRes = await client.query(
      `SELECT base_currency FROM teams WHERE id = $1`,
      [input.teamId],
    );
    const functional: string = teamRes.rows[0]?.base_currency ?? "EUR";
    const date = input.date ?? new Date().toISOString().slice(0, 10);

    // Greedy pairwise allocation of open residuals.
    const debits = lines
      .filter((l) => l.residual > 0)
      .map((l) => ({ ...l, open: l.residual }));
    const credits = lines
      .filter((l) => l.residual < 0)
      .map((l) => ({ ...l, open: -l.residual }));
    let allocatedCents = 0;
    for (const d of debits) {
      for (const c of credits) {
        if (d.open === 0) break;
        if (c.open === 0) continue;
        const amt = Math.min(d.open, c.open);
        await client.query(
          `INSERT INTO reconciliation_allocations (team_id, debit_line_id, credit_line_id, amount)
           VALUES ($1, $2, $3, $4)`,
          [input.teamId, d.id, c.id, (amt / 100).toFixed(2)],
        );
        d.open -= amt;
        c.open -= amt;
        allocatedCents += amt;
      }
    }
    let residualCents =
      debits.reduce((s, d) => s + d.open, 0) -
      credits.reduce((s, c) => s + c.open, 0);

    // Residual settlement: realized FX, or a tolerated payment difference.
    let residualEntry: ReconcileResult["residualEntry"];
    if (residualCents !== 0) {
      const foreign = lines.every((l) => l.currency === lines[0]?.currency)
        ? lines[0]?.currency
        : undefined;
      const fxNets =
        foreign !== undefined &&
        foreign !== functional &&
        lines.reduce((s, l) => s + l.amount_currency, 0) === 0 &&
        lines.every((l) => l.allocated === 0 || l.residual === 0);
      const tolerated =
        Math.abs(residualCents) <= cents(input.writeOffTolerance ?? 0);

      if (fxNets || tolerated) {
        const kind = fxNets ? ("fx" as const) : ("write_off" as const);
        const gainKey = fxNets ? "fx_gain_realized" : "payment_diff_gain";
        const lossKey = fxNets ? "fx_loss_realized" : "payment_diff_loss";
        const abs = Math.abs(residualCents) / 100;
        const openDebit = residualCents > 0;
        // openDebit (debtor still owed in functional terms) -> credit the account, book the loss.
        const posted = await postEntry(client, {
          teamId: input.teamId,
          journalCode: input.journalCode ?? "800",
          date,
          narration: fxNets
            ? "Realized exchange difference"
            : "Payment difference write-off",
          sourceType: "reconciliation",
          manageTransaction: false,
          lines: [
            {
              accountId: account.account_id,
              ...(openDebit ? { credit: abs } : { debit: abs }),
              currency: functional,
              amountCurrency: openDebit ? -abs : abs,
              ...(account.party_type && account.party_id
                ? {
                    partyType: account.party_type as
                      | "customer"
                      | "supplier"
                      | "employee",
                    partyId: account.party_id,
                  }
                : {}),
              description: fxNets ? "FX settlement difference" : "Write-off",
            },
            {
              systemKey: openDebit ? lossKey : gainKey,
              ...(openDebit ? { debit: abs } : { credit: abs }),
              currency: functional,
              amountCurrency: openDebit ? abs : -abs,
              description: fxNets ? "FX settlement difference" : "Write-off",
            },
          ],
        });
        const closing = await client.query(
          `SELECT ll.id, ll.debit, ll.credit FROM ledger_lines ll
            WHERE ll.entry_id = $1 AND ll.account_id = $2`,
          [posted.entryId, account.account_id],
        );
        const closingLine = closing.rows[0];
        // Allocate the closing line against the remaining open residuals.
        if (openDebit) {
          let left = Math.abs(residualCents);
          for (const d of debits) {
            if (d.open === 0 || left === 0) continue;
            const amt = Math.min(d.open, left);
            await client.query(
              `INSERT INTO reconciliation_allocations (team_id, debit_line_id, credit_line_id, amount)
               VALUES ($1, $2, $3, $4)`,
              [input.teamId, d.id, closingLine.id, (amt / 100).toFixed(2)],
            );
            d.open -= amt;
            left -= amt;
          }
        } else {
          let left = Math.abs(residualCents);
          for (const c of credits) {
            if (c.open === 0 || left === 0) continue;
            const amt = Math.min(c.open, left);
            await client.query(
              `INSERT INTO reconciliation_allocations (team_id, debit_line_id, credit_line_id, amount)
               VALUES ($1, $2, $3, $4)`,
              [input.teamId, closingLine.id, c.id, (amt / 100).toFixed(2)],
            );
            c.open -= amt;
            left -= amt;
          }
        }
        residualCents = 0;
        residualEntry = { ...posted, kind };
        lines.push({
          id: closingLine.id,
          account_id: account.account_id,
          account_code: account.account_code,
          party_type: null,
          party_id: null,
          currency: functional,
          amount_currency: 0,
          debit: cents(closingLine.debit),
          credit: cents(closingLine.credit),
          allocated: 0,
          residual: 0,
        });
      }
    }

    let reconciliationId: string | undefined;
    if (residualCents === 0) {
      const rec = await client.query(
        `INSERT INTO reconciliations (team_id, status) VALUES ($1, 'full') RETURNING id`,
        [input.teamId],
      );
      reconciliationId = rec.rows[0].id;
      await client.query(
        `UPDATE ledger_lines SET reconciliation_id = $1 WHERE id = ANY($2::uuid[])`,
        [reconciliationId, lines.map((l) => l.id)],
      );
    }

    await client.query("COMMIT");
    return {
      status: residualCents === 0 ? "full" : "partial",
      reconciliationId,
      allocated: allocatedCents / 100,
      residual: residualCents / 100,
      residualEntry,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

/** Undo allocations (metadata only; posted lines are never touched). */
export async function unallocate(
  client: PoolClient,
  input: { teamId: string; allocationIds: string[] },
): Promise<{ removed: number }> {
  await client.query("BEGIN");
  try {
    const res = await client.query(
      `DELETE FROM reconciliation_allocations
        WHERE team_id = $1 AND id = ANY($2::uuid[])
        RETURNING debit_line_id, credit_line_id`,
      [input.teamId, input.allocationIds],
    );
    const lineIds = [
      ...new Set(res.rows.flatMap((r) => [r.debit_line_id, r.credit_line_id])),
    ];
    if (lineIds.length > 0) {
      // Any group containing these lines is no longer fully matched.
      await client.query(
        `UPDATE ledger_lines SET reconciliation_id = NULL
          WHERE reconciliation_id IN (
            SELECT DISTINCT reconciliation_id FROM ledger_lines
             WHERE id = ANY($1::uuid[]) AND reconciliation_id IS NOT NULL)`,
        [lineIds],
      );
    }
    await client.query("COMMIT");
    return { removed: res.rowCount ?? 0 };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}
