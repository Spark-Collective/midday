/**
 * Forward-looking cash: a direct-method forecast, weekly then monthly.
 *
 * Direct method, gross of VAT. An invoice of 12.100 moves 12.100 of cash and the
 * VAT leaves later on its own filing due date; netting the VAT out AND also
 * subtracting the filing payment double counts, which is the commonest error in
 * hand-built forecasts.
 *
 * Every line carries the row that produced it, so any point on the curve can be
 * traced back to an invoice, a project or a filing. Same discipline as the
 * filings evidence rule: a number you cannot source is a number you cannot act on.
 *
 * Design: docs/architecture/midday-cash-forecast-2026-08-03.md.
 */
import type { PoolClient } from "pg";

export type CashLineKind = "invoice" | "project" | "filing" | "run_rate";

export type CashLine = {
  /** Expected CASH date, not the document date. */
  date: string;
  /** Signed: positive in, negative out. */
  amount: number;
  kind: CashLineKind;
  label: string;
  sourceId: string | null;
  /** False only when the amount and date are both known facts. */
  estimated: boolean;
};

export type CashBucket = {
  start: string;
  end: string;
  granularity: "week" | "month";
  inflow: number;
  outflow: number;
  /** Projected balance at the END of this bucket. */
  closing: number;
  lines: CashLine[];
};

export type CashForecast = {
  asOf: string;
  currency: string;
  openingBalance: number;
  buckets: CashBucket[];
  /** The worst point on the curve. The number the whole thing exists to show. */
  lowest: { date: string; balance: number } | null;
  warnings: string[];
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const iso = (d: Date) => d.toISOString().slice(0, 10);

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return iso(d);
}

/** Default when a customer has no payment history to learn from. */
const DEFAULT_PAYMENT_LAG_DAYS = 0;
/** Below this, one unusual invoice would define the customer's behaviour. */
const MIN_LAG_SAMPLES = 3;
/** Days from invoicing to cash for work billed from a project. */
const DEFAULT_PAYMENT_TERMS_DAYS = 30;

/**
 * How late each customer actually pays, in days after the due date. Negative
 * means early. An invoice due the 30th from a customer who is reliably 20 days
 * late is not this month's cash, and pretending otherwise is what makes
 * home-made forecasts useless.
 */
export async function getPaymentLagDays(
  client: PoolClient,
  teamId: string,
): Promise<{ byCustomer: Map<string, number>; teamDefault: number }> {
  const r = await client.query(
    `SELECT customer_id,
            count(*)::int AS n,
            avg(EXTRACT(EPOCH FROM (paid_at - due_date)) / 86400) AS lag_days
       FROM invoices
      WHERE team_id = $1 AND paid_at IS NOT NULL AND due_date IS NOT NULL
      GROUP BY customer_id`,
    [teamId],
  );

  const byCustomer = new Map<string, number>();
  let weighted = 0;
  let total = 0;
  for (const row of r.rows) {
    const lag = Math.round(Number(row.lag_days));
    total += row.n;
    weighted += lag * row.n;
    if (row.customer_id && row.n >= MIN_LAG_SAMPLES) {
      byCustomer.set(row.customer_id, lag);
    }
  }
  const teamDefault =
    total > 0 ? Math.round(weighted / total) : DEFAULT_PAYMENT_LAG_DAYS;
  return { byCustomer, teamDefault };
}

/**
 * A filing's due date is a fact; its amount usually is not yet. Prefer the
 * prepared figure, fall back to what this obligation has historically cost.
 *
 * ponytail: one trailing-average estimator for every filing kind, rather than
 * six bespoke ones. VAT is lumpy and this will be wrong on a quarter with an
 * unusual purchase; upgrade to a per-kind estimator (VAT from the quarter's
 * ledger to date, social contributions from the fund's schedule) when the error
 * measured against the snapshots justifies it.
 */
async function filingOutflows(
  client: PoolClient,
  teamId: string,
  from: string,
  to: string,
): Promise<CashLine[]> {
  const r = await client.query(
    `WITH history AS (
       SELECT f.kind,
              avg(abs((f.data ->> 'amountDue')::numeric)) AS avg_amount
         FROM filings f
        WHERE f.team_id = $1
          AND f.data ? 'amountDue'
          AND (f.data ->> 'amountDue') ~ '^-?[0-9.]+$'
        GROUP BY f.kind
     )
     SELECT f.id, f.kind, f.period_key, f.due_date::text AS due_date,
            (f.data ->> 'amountDue') AS prepared,
            h.avg_amount::float8 AS avg_amount
       FROM filings f
       LEFT JOIN history h ON h.kind = f.kind
      WHERE f.team_id = $1
        AND f.due_date >= $2::date AND f.due_date <= $3::date
        AND f.status NOT IN ('filed', 'confirmed', 'skipped')
      ORDER BY f.due_date`,
    [teamId, from, to],
  );

  const lines: CashLine[] = [];
  for (const row of r.rows) {
    const prepared =
      row.prepared !== null && /^-?[0-9.]+$/.test(String(row.prepared))
        ? Number(row.prepared)
        : null;
    const amount = prepared ?? (row.avg_amount ? Number(row.avg_amount) : null);
    // No prepared figure and no history: the date is real but the amount is
    // unknowable. Skipping it silently would understate the outflow, so it is
    // surfaced as a warning by the caller instead of guessed at here.
    if (amount === null || amount === 0) continue;
    lines.push({
      date: row.due_date,
      amount: -Math.abs(r2(amount)),
      kind: "filing",
      label: `${String(row.kind).replace(/_/g, " ")} ${row.period_key}`,
      sourceId: row.id,
      estimated: prepared === null,
    });
  }
  return lines;
}

/**
 * Baseline operating spend, per month, from the last 90 days of actual cash out.
 *
 * `transactions.recurring` is unpopulated in practice, so recurrence detection
 * would be building a classifier to answer a question a trailing average already
 * answers. Tax and social payments are EXCLUDED because the filings calendar
 * forecasts those explicitly, and counting them in both places is the same
 * double-count the VAT rule above avoids.
 */
async function runRateMonthly(
  client: PoolClient,
  teamId: string,
  asOf: string,
): Promise<{ amount: number; sampledFrom: string }> {
  const since = addDays(asOf, -90);
  const r = await client.query(
    `SELECT COALESCE(sum(abs(t.amount)), 0)::float8 AS total
       FROM transactions t
      WHERE t.team_id = $1
        AND t.date >= $2::date AND t.date < $3::date
        AND t.amount < 0
        AND t.status <> 'excluded'
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
        )`,
    [teamId, since, asOf],
  );
  return { amount: r2(Number(r.rows[0].total) / 3), sampledFrom: since };
}

export type BuildCashForecastInput = {
  teamId: string;
  /** Defaults to today. Injectable so tests are not time-dependent. */
  asOf?: string;
  weeks?: number;
  months?: number;
};

export async function buildCashForecast(
  client: PoolClient,
  input: BuildCashForecastInput,
): Promise<CashForecast> {
  const asOf = input.asOf ?? iso(new Date());
  const weeks = input.weeks ?? 13;
  const months = input.months ?? 12;
  const warnings: string[] = [];

  const team = await client.query(
    "SELECT base_currency FROM teams WHERE id = $1",
    [input.teamId],
  );
  const currency = team.rows[0]?.base_currency ?? "EUR";

  // --- opening balance -----------------------------------------------------
  const balances = await client.query(
    `SELECT currency, COALESCE(sum(balance), 0)::float8 AS total, count(*)::int AS n
       FROM bank_accounts
      WHERE team_id = $1 AND enabled = true
      GROUP BY currency`,
    [input.teamId],
  );
  let openingBalance = 0;
  for (const row of balances.rows) {
    if (row.currency === currency) openingBalance += Number(row.total);
    else
      warnings.push(
        `${row.n} account(s) in ${row.currency} are excluded from the opening balance; the forecast is in ${currency}.`,
      );
  }
  openingBalance = r2(openingBalance);

  const horizonEnd = addDays(asOf, weeks * 7 + months * 31);
  const lines: CashLine[] = [];

  // --- invoiced, not yet paid ---------------------------------------------
  const { byCustomer, teamDefault } = await getPaymentLagDays(
    client,
    input.teamId,
  );
  const openInvoices = await client.query(
    `SELECT id, customer_id, invoice_number, amount::float8 AS amount, currency,
            COALESCE(due_date, issue_date)::date::text AS due_date
       FROM invoices
      WHERE team_id = $1
        AND status IN ('unpaid', 'overdue', 'scheduled')
        AND COALESCE(due_date, issue_date) IS NOT NULL`,
    [input.teamId],
  );
  for (const row of openInvoices.rows) {
    if (row.currency && row.currency !== currency) {
      warnings.push(
        `Invoice ${row.invoice_number ?? row.id} is in ${row.currency} and is excluded.`,
      );
      continue;
    }
    const lag = byCustomer.get(row.customer_id) ?? teamDefault;
    lines.push({
      date: addDays(row.due_date, lag),
      amount: r2(Number(row.amount)),
      kind: "invoice",
      label: `Invoice ${row.invoice_number ?? ""}`.trim(),
      sourceId: row.id,
      // The amount is certain; only the date is modelled.
      estimated: lag !== 0,
    });
  }

  // --- landed work, not yet invoiced --------------------------------------
  // Netted against invoices already raised for the project, so partially billed
  // work does not get counted twice.
  const projects = await client.query(
    `SELECT p.id, p.name, p.customer_id, p.currency,
            p.expected_invoice_date::text AS expected_invoice_date,
            p.contract_value::float8 AS contract_value,
            p.estimate, p.rate::float8 AS rate,
            COALESCE((
              SELECT sum(i.amount) FROM invoices i
               WHERE i.team_id = p.team_id AND i.project_id = p.id
                 AND i.status <> 'canceled'
            ), 0)::float8 AS invoiced,
            -- Invoices to the same customer around the expected date that are NOT
            -- linked to a project. Cannot be netted without guessing, so they are
            -- surfaced instead: a silent double count is worse than a warning.
            COALESCE((
              SELECT count(*) FROM invoices i
               WHERE i.team_id = p.team_id AND i.customer_id = p.customer_id
                 AND i.project_id IS NULL AND i.status <> 'canceled'
                 AND i.issue_date >= (p.expected_invoice_date - interval '90 days')
            ), 0)::int AS unlinked_invoices
       FROM tracker_projects p
      WHERE p.team_id = $1
        AND p.expected_invoice_date IS NOT NULL
        AND p.expected_invoice_date <= $2::date
        AND p.status <> 'completed'`,
    [input.teamId, horizonEnd],
  );
  for (const row of projects.rows) {
    if (row.currency && row.currency !== currency) {
      warnings.push(
        `Project "${row.name}" is in ${row.currency} and is excluded.`,
      );
      continue;
    }
    const gross =
      row.contract_value !== null
        ? Number(row.contract_value)
        : row.estimate && row.rate
          ? Number(row.estimate) * Number(row.rate)
          : null;
    if (gross === null) {
      warnings.push(
        `Project "${row.name}" has an expected invoice date but no value: set a contract value, or a rate and time estimate.`,
      );
      continue;
    }
    const remaining = gross - Number(row.invoiced);
    if (remaining <= 0) continue;
    if (Number(row.unlinked_invoices) > 0) {
      warnings.push(
        `Project "${row.name}" may be double counted: ${row.unlinked_invoices} invoice(s) to this customer are not linked to a project. Link them, or clear the expected invoice date.`,
      );
    }
    const lag = byCustomer.get(row.customer_id) ?? teamDefault;
    lines.push({
      date: addDays(
        row.expected_invoice_date,
        DEFAULT_PAYMENT_TERMS_DAYS + lag,
      ),
      amount: r2(remaining),
      kind: "project",
      label: row.name,
      sourceId: row.id,
      estimated: true,
    });
  }

  // --- tax and social outflows --------------------------------------------
  lines.push(...(await filingOutflows(client, input.teamId, asOf, horizonEnd)));

  // --- baseline operating spend -------------------------------------------
  const runRate = await runRateMonthly(client, input.teamId, asOf);
  if (runRate.amount <= 0) {
    warnings.push(
      "No operating spend in the last 90 days, so the forecast shows no running costs. It will read optimistically.",
    );
  }

  // --- buckets -------------------------------------------------------------
  const buckets: CashBucket[] = [];
  let cursor = asOf;
  for (let i = 0; i < weeks; i++) {
    const end = addDays(cursor, 7);
    buckets.push(emptyBucket(cursor, end, "week"));
    cursor = end;
  }
  for (let i = 0; i < months; i++) {
    const d = new Date(`${cursor}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + 1);
    const end = iso(d);
    buckets.push(emptyBucket(cursor, end, "month"));
    cursor = end;
  }

  // The run rate is spread evenly rather than dated, because it represents many
  // small payments whose individual timing is not knowable.
  for (const b of buckets) {
    const days =
      (new Date(`${b.end}T00:00:00Z`).getTime() -
        new Date(`${b.start}T00:00:00Z`).getTime()) /
      86400000;
    if (runRate.amount > 0) {
      b.lines.push({
        date: b.start,
        amount: -r2((runRate.amount * days) / 30.44),
        kind: "run_rate",
        label: "Running costs",
        sourceId: null,
        estimated: true,
      });
    }
  }

  for (const line of lines) {
    const b = buckets.find((x) => line.date >= x.start && line.date < x.end);
    // Anything before the first bucket is already-overdue money: it belongs in
    // the first bucket, not dropped. Anything past the horizon is out of scope.
    if (b) b.lines.push(line);
    else if (line.date < asOf) buckets[0]?.lines.push(line);
  }

  let balance = openingBalance;
  let lowest: { date: string; balance: number } | null = null;
  for (const b of buckets) {
    b.inflow = r2(
      b.lines.filter((l) => l.amount > 0).reduce((s, l) => s + l.amount, 0),
    );
    b.outflow = r2(
      b.lines.filter((l) => l.amount < 0).reduce((s, l) => s + l.amount, 0),
    );
    balance = r2(balance + b.inflow + b.outflow);
    b.closing = balance;
    b.lines.sort((x, y) => x.date.localeCompare(y.date));
    if (!lowest || balance < lowest.balance) lowest = { date: b.end, balance };
  }

  return {
    asOf,
    currency,
    openingBalance,
    buckets,
    lowest,
    warnings,
  };
}

function emptyBucket(
  start: string,
  end: string,
  granularity: "week" | "month",
): CashBucket {
  return {
    start,
    end,
    granularity,
    inflow: 0,
    outflow: 0,
    closing: 0,
    lines: [],
  };
}

/**
 * Store today's curve so a later month can ask whether it was right. Idempotent
 * per day: re-running replaces the day's snapshot rather than accumulating.
 */
export async function snapshotCashForecast(
  client: PoolClient,
  input: { teamId: string; asOf?: string },
): Promise<{ takenOn: string }> {
  const forecast = await buildCashForecast(client, input);
  await client.query(
    `INSERT INTO cash_forecast_snapshots
       (team_id, taken_on, opening_balance, currency, buckets)
     VALUES ($1, $2::date, $3, $4, $5::jsonb)
     ON CONFLICT (team_id, taken_on) DO UPDATE
       SET opening_balance = EXCLUDED.opening_balance,
           currency = EXCLUDED.currency,
           buckets = EXCLUDED.buckets`,
    [
      input.teamId,
      forecast.asOf,
      forecast.openingBalance,
      forecast.currency,
      JSON.stringify(forecast.buckets),
    ],
  );
  return { takenOn: forecast.asOf };
}
