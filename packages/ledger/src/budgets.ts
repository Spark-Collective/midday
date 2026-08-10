/**
 * Planned spend per category per month.
 *
 * A budget module that only draws a bar chart is a report nobody opens twice.
 * The reason this one earns its place is that it feeds the cash forecast: where
 * a month has a budget, the forecast uses your intent instead of a blind 90-day
 * trailing average. That also means budgets and the run rate must never both
 * count the same category, which is what `getOperatingPlan` exists to guarantee.
 *
 * Design: docs/midday-os/specs/midday-cash-forecast.md.
 */
import type { PoolClient } from "pg";
import { LedgerError } from "./post.js";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Transactions with no category at all are grouped under this key. */
export const UNCATEGORISED = "__uncategorised__";

export type BudgetRow = {
  categorySlug: string;
  categoryName: string | null;
  month: string;
  budget: number | null;
  actual: number;
  /** budget - actual. Negative means over. Null when there is no budget. */
  variance: number | null;
};

function assertMonth(month: string) {
  if (!MONTH_RE.test(month)) {
    throw new LedgerError(`month must be YYYY-MM, got "${month}"`);
  }
}

/** Upsert a month's budget for one category. A null amount removes it. */
export async function setBudget(
  client: PoolClient,
  input: {
    teamId: string;
    categorySlug: string;
    month: string;
    amount: number | null;
  },
): Promise<void> {
  assertMonth(input.month);
  if (input.amount === null) {
    await client.query(
      `DELETE FROM budgets WHERE team_id = $1 AND category_slug = $2 AND period_key = $3`,
      [input.teamId, input.categorySlug, input.month],
    );
    return;
  }
  if (input.amount < 0) {
    throw new LedgerError("a budget is planned spend and cannot be negative");
  }
  await client.query(
    `INSERT INTO budgets (team_id, category_slug, period_key, amount)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (team_id, category_slug, period_key)
       DO UPDATE SET amount = EXCLUDED.amount, updated_at = now()`,
    [input.teamId, input.categorySlug, input.month, r2(input.amount)],
  );
}

/**
 * Repeat a month's budget across the rest of its year. Nobody types twelve
 * months by hand, and a budget module that expects them to is one that stays
 * empty.
 */
export async function copyBudgetForward(
  client: PoolClient,
  input: { teamId: string; categorySlug: string; month: string },
): Promise<{ months: string[] }> {
  assertMonth(input.month);
  const [yearStr, monthStr] = input.month.split("-");
  const year = Number(yearStr);
  const from = Number(monthStr);

  const current = await client.query(
    `SELECT amount::float8 AS amount FROM budgets
      WHERE team_id = $1 AND category_slug = $2 AND period_key = $3`,
    [input.teamId, input.categorySlug, input.month],
  );
  if (current.rowCount === 0) {
    throw new LedgerError(
      `no budget set for ${input.categorySlug} in ${input.month}, so there is nothing to copy`,
    );
  }
  const amount = Number(current.rows[0].amount);

  const months: string[] = [];
  for (let m = from + 1; m <= 12; m++) {
    months.push(`${year}-${String(m).padStart(2, "0")}`);
  }
  for (const month of months) {
    await setBudget(client, { ...input, month, amount });
  }
  return { months };
}

/**
 * Budget against what was actually spent, for one month.
 *
 * Categories are included when they have a budget OR any spend, so an
 * unbudgeted overspend cannot hide by not being on the list. Categories the team
 * marked excluded are left out entirely: they are excluded from reporting by
 * definition, and budgeting them would contradict that.
 */
export async function getBudgetVsActual(
  client: PoolClient,
  input: { teamId: string; month: string },
): Promise<{ rows: BudgetRow[]; budgetTotal: number; actualTotal: number }> {
  assertMonth(input.month);
  const r = await client.query(
    `WITH spend AS (
       SELECT COALESCE(t.category_slug, $3) AS slug,
              sum(abs(t.amount))::numeric AS actual
         FROM transactions t
         LEFT JOIN transaction_categories c
           ON c.team_id = t.team_id AND c.slug = t.category_slug
        WHERE t.team_id = $1
          AND to_char(t.date, 'YYYY-MM') = $2
          AND t.amount < 0
          AND t.status <> 'excluded'
          AND COALESCE(c.excluded, false) = false
        GROUP BY 1
     ),
     planned AS (
       SELECT category_slug AS slug, amount FROM budgets
        WHERE team_id = $1 AND period_key = $2
     )
     SELECT COALESCE(p.slug, s.slug) AS slug,
            c.name AS category_name,
            p.amount::float8 AS budget,
            COALESCE(s.actual, 0)::float8 AS actual
       FROM planned p
       FULL OUTER JOIN spend s ON s.slug = p.slug
       LEFT JOIN transaction_categories c
         ON c.team_id = $1 AND c.slug = COALESCE(p.slug, s.slug)
      ORDER BY COALESCE(s.actual, 0) DESC, 1`,
    [input.teamId, input.month, UNCATEGORISED],
  );

  const rows: BudgetRow[] = r.rows.map((row) => {
    const budget = row.budget === null ? null : Number(row.budget);
    const actual = r2(Number(row.actual));
    return {
      categorySlug: row.slug,
      categoryName: row.category_name,
      month: input.month,
      budget,
      actual,
      variance: budget === null ? null : r2(budget - actual),
    };
  });

  return {
    rows,
    budgetTotal: r2(rows.reduce((s, x) => s + (x.budget ?? 0), 0)),
    actualTotal: r2(rows.reduce((s, x) => s + x.actual, 0)),
  };
}

export type OperatingPlan = {
  /** Monthly spend rate per category, learned from the last 90 days. */
  trailingByCategory: Map<string, number>;
  /** "<slug>|<YYYY-MM>" -> planned amount for that month. */
  budgetByCategoryMonth: Map<string, number>;
  /** Categories carrying a budget somewhere in the window, for labelling. */
  categoryNames: Map<string, string>;
};

/**
 * Everything the forecast needs to project operating spend without counting
 * anything twice.
 *
 * Tax and social payments are excluded from the trailing average because the
 * filings calendar dates those explicitly. Budgets are returned separately
 * rather than merged so the caller can prefer intent over history month by
 * month, and still show which is which.
 */
export async function getOperatingPlan(
  client: PoolClient,
  input: { teamId: string; asOf: string; through: string },
): Promise<OperatingPlan> {
  const trailing = await client.query(
    `SELECT COALESCE(t.category_slug, $3) AS slug,
            (sum(abs(t.amount)) / 3)::float8 AS monthly
       FROM transactions t
       LEFT JOIN transaction_categories c
         ON c.team_id = t.team_id AND c.slug = t.category_slug
      WHERE t.team_id = $1
        AND t.date >= ($2::date - interval '90 days') AND t.date < $2::date
        AND t.amount < 0
        AND t.status <> 'excluded'
        AND COALESCE(c.excluded, false) = false
        AND NOT EXISTS (
          SELECT 1
            FROM journal_entries je
            JOIN ledger_lines ll ON ll.entry_id = je.id
            JOIN gl_accounts a ON a.id = ll.account_id
           WHERE je.team_id = t.team_id
             AND je.source_type = 'transaction' AND je.source_id = t.id
             AND a.system_key IN ('social_contributions_paid',
                                  'advance_tax_payment',
                                  'corporate_tax_payable',
                                  'vat_payable',
                                  'vat_current_account')
        )
      GROUP BY 1`,
    [input.teamId, input.asOf, UNCATEGORISED],
  );

  const planned = await client.query(
    `SELECT b.category_slug, b.period_key, b.amount::float8 AS amount, c.name
       FROM budgets b
       LEFT JOIN transaction_categories c
         ON c.team_id = b.team_id AND c.slug = b.category_slug
      WHERE b.team_id = $1
        AND b.period_key >= to_char($2::date, 'YYYY-MM')
        AND b.period_key <= to_char($3::date, 'YYYY-MM')`,
    [input.teamId, input.asOf, input.through],
  );

  return {
    trailingByCategory: new Map(
      trailing.rows.map((row) => [row.slug as string, Number(row.monthly)]),
    ),
    budgetByCategoryMonth: new Map(
      planned.rows.map((row) => [
        `${row.category_slug}|${row.period_key}`,
        Number(row.amount),
      ]),
    ),
    categoryNames: new Map(
      planned.rows
        .filter((row) => row.name)
        .map((row) => [row.category_slug as string, row.name as string]),
    ),
  };
}
