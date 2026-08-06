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
import {
  getOperatingPlan,
  type OperatingPlan,
  UNCATEGORISED,
} from "./budgets.js";

export type CashLineKind =
  | "invoice"
  | "project"
  | "proposal"
  | "filing"
  | "budget"
  | "run_rate";

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
/** How often a recurring price is actually billed. */
const MONTHS_PER_INTERVAL: Record<string, number> = {
  month: 1,
  quarter: 3,
  year: 12,
};
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
 * What each obligation has historically cost in CASH, learned from the account
 * it settles against. The filings table itself is the wrong place to learn this
 * from: a prepared VAT return stores its grids, not a single figure, and most
 * obligations are never "prepared" in the app at all. The ledger, by contrast,
 * has the actual payments.
 */
const FILING_COST_ACCOUNT: Record<string, string> = {
  social_contribution: "social_contributions_paid",
  advance_payment: "advance_tax_payment",
  vat_return: "vat_current_account",
  corporate_tax: "corporate_tax_payable",
};

/**
 * A filing's due date is a fact; its amount usually is not yet.
 *
 * Order of preference: the prepared figure (VAT grid 71 payable / 72
 * refundable), then the average of what this obligation has actually cost over
 * the last year. Neither available means the amount is genuinely unknown, and
 * the caller says so rather than the curve quietly omitting a tax bill.
 *
 * ponytail: a flat average of the last year's payments, not a model. VAT is
 * lumpy and this will be wrong on a quarter with an unusual purchase; the
 * monthly snapshots are what will eventually say whether that matters.
 */
async function filingOutflows(
  client: PoolClient,
  teamId: string,
  from: string,
  to: string,
): Promise<{ lines: CashLine[]; unknown: string[] }> {
  const history = await client.query(
    `WITH payments AS (
       SELECT a.system_key AS key, je.id AS entry_id, sum(ll.debit) AS amt
         FROM ledger_lines ll
         JOIN journal_entries je ON je.id = ll.entry_id AND je.status = 'posted'
         JOIN gl_accounts a ON a.id = ll.account_id
        WHERE ll.team_id = $1
          AND a.system_key = ANY($2::text[])
          AND je.date >= ($3::date - interval '365 days')
          AND ll.debit > 0
        GROUP BY 1, 2
     )
     SELECT key, avg(amt)::float8 AS avg_amount FROM payments GROUP BY key`,
    [teamId, Object.values(FILING_COST_ACCOUNT), from],
  );
  const avgByAccount = new Map<string, number>(
    history.rows.map((r) => [r.key as string, Number(r.avg_amount)]),
  );

  const r = await client.query(
    `SELECT id, kind, period_key, due_date::text AS due_date,
            (data -> 'grids' ->> '71') AS vat_payable,
            (data -> 'grids' ->> '72') AS vat_refundable
       FROM filings
      WHERE team_id = $1
        AND due_date >= $2::date AND due_date <= $3::date
        AND status NOT IN ('filed', 'confirmed', 'skipped')
      ORDER BY due_date`,
    [teamId, from, to],
  );

  const lines: CashLine[] = [];
  const unknown: string[] = [];
  for (const row of r.rows) {
    const label = `${String(row.kind).replace(/_/g, " ")} ${row.period_key}`;

    // A prepared VAT return knows exactly which way the money goes.
    const payable = num(row.vat_payable);
    const refundable = num(row.vat_refundable);
    if (payable !== null || refundable !== null) {
      const signed = payable !== null ? -payable : (refundable ?? 0);
      if (signed !== 0) {
        lines.push({
          date: row.due_date,
          amount: r2(signed),
          kind: "filing",
          label,
          sourceId: row.id,
          estimated: false,
        });
      }
      continue;
    }

    const account = FILING_COST_ACCOUNT[String(row.kind)];
    const avg = account ? avgByAccount.get(account) : undefined;
    if (!avg) {
      // Listings and annual accounts cost nothing to file, so silence is right
      // for them. A payment obligation with no history is not.
      if (account) unknown.push(label);
      continue;
    }
    lines.push({
      date: row.due_date,
      amount: -Math.abs(r2(avg)),
      kind: "filing",
      label,
      sourceId: row.id,
      estimated: true,
    });
  }
  return { lines, unknown };
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

/** Whole days of overlap between [aStart,aEnd) and [bStart,bEnd). */
function overlapDays(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string,
): number {
  const start = aStart > bStart ? aStart : bStart;
  const end = aEnd < bEnd ? aEnd : bEnd;
  if (start >= end) return 0;
  return (
    (new Date(`${end}T00:00:00Z`).getTime() -
      new Date(`${start}T00:00:00Z`).getTime()) /
    86400000
  );
}

/** First day of the month containing `date`, and of the month after it. */
function monthBounds(date: string): {
  key: string;
  start: string;
  end: string;
} {
  const d = new Date(`${date}T00:00:00Z`);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return { key: iso(start).slice(0, 7), start: iso(start), end: iso(end) };
}

/**
 * Operating spend for one bucket, category by category.
 *
 * For each category and each month the bucket touches: a budget for that month
 * wins, otherwise the category's own 90-day trailing rate. That is the whole
 * point of the budget layer, and it is also why the two can never be added
 * together for the same category-month.
 *
 * Budgeted categories are emitted as their own lines so the curve says which
 * numbers are intent and which are history; everything else is aggregated into
 * one "Running costs" line, because a dozen sub-hundred-euro lines per week is
 * noise, not traceability.
 */
function operatingLines(
  bucketStart: string,
  bucketEnd: string,
  plan: OperatingPlan,
): CashLine[] {
  const categories = new Set<string>(plan.trailingByCategory.keys());
  for (const key of plan.budgetByCategoryMonth.keys()) {
    categories.add(key.split("|")[0] as string);
  }

  // Walk the months this bucket touches (a weekly bucket touches one or two).
  const months: Array<{ key: string; start: string; end: string }> = [];
  let cursor = bucketStart;
  while (cursor < bucketEnd) {
    const m = monthBounds(cursor);
    months.push(m);
    cursor = m.end;
  }

  const lines: CashLine[] = [];
  let aggregated = 0;
  for (const slug of categories) {
    let budgeted = 0;
    let trailing = 0;
    for (const m of months) {
      const days = overlapDays(bucketStart, bucketEnd, m.start, m.end);
      if (days === 0) continue;
      const daysInMonth = overlapDays(m.start, m.end, m.start, m.end);
      const budget = plan.budgetByCategoryMonth.get(`${slug}|${m.key}`);
      if (budget !== undefined) budgeted += (budget * days) / daysInMonth;
      else
        trailing +=
          ((plan.trailingByCategory.get(slug) ?? 0) * days) / daysInMonth;
    }
    if (budgeted > 0) {
      lines.push({
        date: bucketStart,
        amount: -r2(budgeted),
        kind: "budget",
        label: plan.categoryNames.get(slug) ?? humanise(slug),
        sourceId: null,
        estimated: true,
      });
    }
    aggregated += trailing;
  }

  if (aggregated > 0) {
    lines.push({
      date: bucketStart,
      amount: -r2(aggregated),
      kind: "run_rate",
      label: "Running costs",
      sourceId: null,
      estimated: true,
    });
  }
  return lines;
}

function humanise(slug: string): string {
  // Midday also ships a category literally named "uncategorized", so this label
  // has to be visibly different from it or the two read as one duplicated row.
  if (slug === UNCATEGORISED) return "No category";
  return slug.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
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

  // --- accepted proposals --------------------------------------------------
  // The only proposal status that is money. Everything before `accepted` is a
  // hope, and a forecast built on hopes cannot be checked against a bank.
  const accepted = await client.query(
    `SELECT p.id, p.number, p.title, p.customer_id, p.currency,
            p.one_off_amount::float8 AS one_off_amount,
            p.recurring_amount::float8 AS recurring_amount,
            p.vat_rate::float8 AS vat_rate,
            p.recurring_interval, p.recurring_months,
            p.expected_invoice_date::text AS expected_invoice_date,
            p.decided_at::date::text AS decided_on,
            COALESCE((
              SELECT sum(i.amount) FROM invoices i
               WHERE i.proposal_id = p.id AND i.status <> 'canceled'
            ), 0)::float8 AS invoiced
       FROM proposals p
      WHERE p.team_id = $1 AND p.status = 'accepted'`,
    [input.teamId],
  );
  for (const row of accepted.rows) {
    if (row.currency && row.currency !== currency) {
      warnings.push(
        `Proposal ${row.number} is in ${row.currency} and is excluded.`,
      );
      continue;
    }
    const lag = byCustomer.get(row.customer_id) ?? teamDefault;

    // Proposals are quoted NET; cash and invoices.amount are GROSS. Gross up
    // before comparing the two, or an 11.000 offer against a 2.420 invoice
    // subtracts a VAT-inclusive figure from a VAT-exclusive one.
    const gross = (n: number) => n * (1 + Number(row.vat_rate ?? 0) / 100);

    // The one-off, less anything already invoiced against this proposal.
    const oneOff =
      gross(Number(row.one_off_amount ?? 0)) - Number(row.invoiced);
    if (oneOff > 0 && row.expected_invoice_date) {
      lines.push({
        date: addDays(
          row.expected_invoice_date,
          DEFAULT_PAYMENT_TERMS_DAYS + lag,
        ),
        amount: r2(oneOff),
        kind: "proposal",
        label: `${row.number} ${row.title}`,
        sourceId: row.id,
        estimated: true,
      });
    }

    // The retainer or SLA fee, repeated to the end of its committed term or the
    // horizon, whichever comes first.
    const every = MONTHS_PER_INTERVAL[row.recurring_interval as string];
    if (row.recurring_amount && every) {
      const start = row.expected_invoice_date ?? row.decided_on ?? asOf;
      const lastMonth =
        row.recurring_months !== null && row.recurring_months !== undefined
          ? Number(row.recurring_months)
          : Number.POSITIVE_INFINITY;
      for (let i = 0, m = 0; m < lastMonth; i++, m += every) {
        const d = new Date(`${start}T00:00:00Z`);
        d.setUTCMonth(d.getUTCMonth() + m);
        const billed = iso(d);
        if (billed > horizonEnd) break;
        const paid = addDays(billed, DEFAULT_PAYMENT_TERMS_DAYS + lag);
        if (paid > horizonEnd) break;
        lines.push({
          date: paid,
          amount: r2(gross(Number(row.recurring_amount))),
          kind: "proposal",
          label: `${row.number} ${row.title} (${row.recurring_interval}ly)`,
          sourceId: row.id,
          estimated: true,
        });
      }
    }
  }

  // --- tax and social outflows --------------------------------------------
  const filings = await filingOutflows(client, input.teamId, asOf, horizonEnd);
  lines.push(...filings.lines);
  if (filings.unknown.length > 0) {
    warnings.push(
      `No amount known yet for ${filings.unknown.join(", ")}. Those payments are NOT in this curve, so it reads better than reality.`,
    );
  }

  // --- baseline operating spend -------------------------------------------
  const plan = await getOperatingPlan(client, {
    teamId: input.teamId,
    asOf,
    through: horizonEnd,
  });
  if (
    plan.trailingByCategory.size === 0 &&
    plan.budgetByCategoryMonth.size === 0
  ) {
    warnings.push(
      "No operating spend in the last 90 days and no budgets, so the forecast shows no running costs. It will read optimistically.",
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

  // Operating spend is spread across each bucket rather than dated, because it
  // represents many small payments whose individual timing is not knowable.
  for (const b of buckets) {
    b.lines.push(...operatingLines(b.start, b.end, plan));
  }

  for (const line of lines) {
    const b = buckets.find((x) => line.date >= x.start && line.date < x.end);
    // Anything before the first bucket is already-overdue money: it belongs in
    // the first bucket, not dropped. Anything past the horizon is out of scope.
    if (b) b.lines.push(line);
    else if (line.date < asOf) buckets[0]?.lines.push(line);
  }

  // A curve with no expected income is not a forecast of the business, it is a
  // forecast of its costs. Saying so is the difference between a useful warning
  // and a frightening, meaningless number.
  if (!lines.some((l) => l.amount > 0)) {
    warnings.push(
      "No expected income is recorded, so this curve shows money leaving only. Add expected invoice dates to your landed work.",
    );
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
