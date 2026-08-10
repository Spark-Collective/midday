/**
 * Asset register (M11): what we own, what it is still worth, and what it costs
 * in depreciation this year.
 *
 * Read-only over the amortization engine, which has posted monthly since
 * January. Spec: docs/midday-os/specs/midday-asset-register.md (spark-workspace).
 *
 * Two things about the data shape drive the code:
 *
 * 1. `amortization_lines` are created WHEN POSTED, not up front. A 44-month
 *    asset with 7 months behind it has 7 rows, not 44. The forward schedule is
 *    therefore COMPUTED from amount/months/residual, never read.
 * 2. `amortizations.amount` is the basis the schedule runs on, which for assets
 *    seeded at the 2026 history import is their NET BOOK VALUE at that date,
 *    not their original cost. So it is reported as "basis" and reconciliation
 *    compares NET BOOK VALUE, never gross. A gross comparison would show a
 *    permanent difference that is not an error, and a check people learn to
 *    ignore is worse than no check.
 */
import type { LedgerDb } from "./post.js";

export type AssetRow = {
  id: string;
  name: string;
  sourceRef: string | null;
  startDate: string;
  months: number;
  status: string;
  assetCode: string;
  assetName: string;
  chargeCode: string | null;
  accumulatedCode: string | null;
  /** What the schedule depreciates (see the header note on its meaning). */
  basis: number;
  residual: number;
  depreciated: number;
  netBookValue: number;
  monthlyCharge: number;
  postedMonths: number;
  remainingMonths: number;
  lastPostedPeriod: string | null;
};

export type AssetRegister = {
  asOf: string;
  year: number;
  assets: AssetRow[];
  totals: {
    basis: number;
    depreciated: number;
    netBookValue: number;
    monthlyCharge: number;
  };
  /** The check that makes the register trustworthy. */
  reconciliation: {
    registerNbv: number;
    ledgerNbv: number;
    difference: number;
    ok: boolean;
    /** The accounts compared, so a difference can be chased. */
    accounts: string[];
  };
  /** Current year: what was posted, and what is still to come. */
  schedule: Array<{ month: string; posted: number; scheduled: number }>;
};

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export async function getAssetRegister(
  client: LedgerDb,
  input: { teamId: string; asOf?: string },
): Promise<AssetRegister> {
  const asOf = input.asOf ?? new Date().toISOString().slice(0, 10);
  const year = Number(asOf.slice(0, 4));
  const asOfMonth = Number(asOf.slice(5, 7));

  const res = await client.query(
    `SELECT am.id, am.name, am.source_ref, am.start_date::text AS start_date,
            am.months, am.status,
            am.amount::float8       AS basis,
            COALESCE(am.residual_value, 0)::float8 AS residual,
            aa.code AS asset_code, aa.name AS asset_name,
            ca.code AS charge_code, ba.code AS accumulated_code,
            aa.id AS asset_account_id, ba.id AS balance_account_id,
            COALESCE(SUM(al.amount) FILTER (WHERE al.entry_id IS NOT NULL), 0)::float8
              AS depreciated,
            COUNT(al.entry_id)::int AS posted_months,
            MAX(fp.year * 100 + fp.month) FILTER (WHERE al.entry_id IS NOT NULL)
              AS last_period
       FROM amortizations am
       JOIN gl_accounts aa ON aa.id = am.asset_account_id
       LEFT JOIN gl_accounts ca ON ca.id = am.charge_account_id
       LEFT JOIN gl_accounts ba ON ba.id = am.balance_account_id
       LEFT JOIN amortization_lines al ON al.amortization_id = am.id
       LEFT JOIN fiscal_periods fp ON fp.id = al.period_id
      WHERE am.team_id = $1
      GROUP BY am.id, am.name, am.source_ref, am.start_date, am.months, am.status,
               am.amount, am.residual_value, aa.code, aa.name, ca.code, ba.code,
               aa.id, ba.id
      ORDER BY am.start_date, am.name`,
    [input.teamId],
  );

  const accountIds = new Set<string>();
  const assets: AssetRow[] = res.rows.map((x) => {
    const basis = Number(x.basis);
    const residual = Number(x.residual);
    const depreciated = r2(Number(x.depreciated));
    const posted = Number(x.posted_months);
    const months = Number(x.months);
    if (x.asset_account_id) accountIds.add(x.asset_account_id);
    if (x.balance_account_id) accountIds.add(x.balance_account_id);
    const lp = x.last_period as number | null;
    return {
      id: x.id,
      name: x.name,
      sourceRef: x.source_ref,
      startDate: x.start_date,
      months,
      status: x.status,
      assetCode: x.asset_code,
      assetName: x.asset_name,
      chargeCode: x.charge_code,
      accumulatedCode: x.accumulated_code,
      basis: r2(basis),
      residual: r2(residual),
      depreciated,
      netBookValue: r2(basis - depreciated),
      monthlyCharge: months > 0 ? r2((basis - residual) / months) : 0,
      postedMonths: posted,
      remainingMonths: Math.max(months - posted, 0),
      lastPostedPeriod: lp
        ? `${Math.floor(lp / 100)}-${String(lp % 100).padStart(2, "0")}`
        : null,
    };
  });

  const totals = assets.reduce(
    (t, a) => ({
      basis: r2(t.basis + a.basis),
      depreciated: r2(t.depreciated + a.depreciated),
      netBookValue: r2(t.netBookValue + a.netBookValue),
      // Only assets still running contribute to the go-forward charge.
      monthlyCharge: r2(
        t.monthlyCharge + (a.remainingMonths > 0 ? a.monthlyCharge : 0),
      ),
    }),
    { basis: 0, depreciated: 0, netBookValue: 0, monthlyCharge: 0 },
  );

  // Reconcile against exactly the accounts the register claims to cover, not
  // all of class 2: a financial fixed asset outside the register would
  // otherwise read as a permanent, meaningless difference.
  let ledgerNbv = 0;
  const accounts: string[] = [];
  if (accountIds.size > 0) {
    const bal = await client.query(
      `SELECT a.code,
              ROUND(SUM(ll.debit - ll.credit)::numeric, 2)::float8 AS balance
         FROM ledger_lines ll
         JOIN journal_entries je ON je.id = ll.entry_id
          AND je.status IN ('posted', 'reversed')
         JOIN gl_accounts a ON a.id = ll.account_id
        WHERE ll.team_id = $1 AND ll.account_id = ANY($2::uuid[])
          AND je.date <= $3::date
        GROUP BY a.code ORDER BY a.code`,
      [input.teamId, [...accountIds], asOf],
    );
    for (const row of bal.rows) {
      ledgerNbv = r2(ledgerNbv + Number(row.balance));
      accounts.push(row.code);
    }
  }
  const difference = r2(totals.netBookValue - ledgerNbv);

  // Posted charge per month for the year, straight from the lines.
  const postedByMonth = new Map<number, number>();
  const sched = await client.query(
    `SELECT fp.month, ROUND(SUM(al.amount)::numeric, 2)::float8 AS amount
       FROM amortization_lines al
       JOIN fiscal_periods fp ON fp.id = al.period_id
      WHERE al.team_id = $1 AND fp.year = $2 AND al.entry_id IS NOT NULL
      GROUP BY fp.month ORDER BY fp.month`,
    [input.teamId, year],
  );
  for (const row of sched.rows) {
    postedByMonth.set(Number(row.month), Number(row.amount));
  }

  // Forward months are COMPUTED: unposted lines do not exist yet. Each asset
  // contributes its monthly charge until its schedule runs out, and the final
  // month takes the rounding remainder so the asset lands exactly on residual.
  const scheduledByMonth = new Map<number, number>();
  for (const a of assets) {
    if (a.status !== "active" || a.remainingMonths <= 0) continue;
    let left = r2(a.netBookValue - a.residual);
    for (let m = asOfMonth + 1, i = 0; m <= 12 && i < a.remainingMonths; m++, i++) {
      const isLast = i === a.remainingMonths - 1;
      const charge = isLast ? left : Math.min(a.monthlyCharge, left);
      if (charge <= 0) break;
      scheduledByMonth.set(m, r2((scheduledByMonth.get(m) ?? 0) + charge));
      left = r2(left - charge);
    }
  }

  const schedule = Array.from({ length: 12 }, (_, i) => {
    const m = i + 1;
    return {
      month: `${year}-${String(m).padStart(2, "0")}`,
      posted: postedByMonth.get(m) ?? 0,
      scheduled: scheduledByMonth.get(m) ?? 0,
    };
  });

  return {
    asOf,
    year,
    assets,
    totals,
    reconciliation: {
      registerNbv: totals.netBookValue,
      ledgerNbv,
      difference,
      ok: Math.abs(difference) < 0.005,
      accounts,
    },
    schedule,
  };
}
