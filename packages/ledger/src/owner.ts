/**
 * The Owner surface: what the director takes out of the company, and what they
 * still owe personally.
 *
 * Everything here is READ-side over the existing ledger. The director's pay,
 * benefits in kind, withholding and social contributions are already posted to
 * specific accounts; this module just knows which accounts mean what, and adds
 * the two things the ledger cannot know: the plan (what should be paid monthly)
 * and the threshold the remuneration is measured against.
 *
 * Design: docs/architecture/midday-compliance-workflows-2026-08-02.md §4.
 */
import type { PoolClient } from "pg";
import { LedgerError } from "./post.js";
import { getTaxParameter, type TaxParameter } from "./tax-params.js";

/**
 * Standard Belgian (PCMN) accounts behind the Owner view, mapped to systemKeys.
 * `linkDirectorAccounts` attaches these to an existing chart; the summary then
 * resolves by systemKey only, never by guessing a code at query time.
 */
export const DIRECTOR_ACCOUNT_KEYS: Array<{
  systemKey: string;
  code: string;
  label: string;
  group:
    | "remuneration"
    | "benefit"
    | "benefit_recovery"
    | "withholding"
    | "social"
    | "advance";
}> = [
  {
    systemKey: "director_remuneration",
    code: "618000",
    label: "Remuneration",
    group: "remuneration",
  },
  {
    systemKey: "director_withholding",
    code: "453000",
    label: "Withholding tax",
    group: "withholding",
  },
  {
    systemKey: "vaa_car",
    code: "618010",
    label: "Company car",
    group: "benefit",
  },
  { systemKey: "vaa_phone", code: "618040", label: "Phone", group: "benefit" },
  { systemKey: "vaa_pc", code: "618070", label: "PC", group: "benefit" },
  {
    systemKey: "vaa_internet",
    code: "618075",
    label: "Internet",
    group: "benefit",
  },
  {
    systemKey: "vaa_car_recovery",
    code: "746410",
    label: "Company car (recovered)",
    group: "benefit_recovery",
  },
  {
    systemKey: "vaa_phone_recovery",
    code: "746440",
    label: "Phone (recovered)",
    group: "benefit_recovery",
  },
  {
    systemKey: "vaa_pc_recovery",
    code: "746470",
    label: "PC (recovered)",
    group: "benefit_recovery",
  },
  {
    systemKey: "vaa_internet_recovery",
    code: "746475",
    label: "Internet (recovered)",
    group: "benefit_recovery",
  },
  {
    systemKey: "social_contributions_paid",
    code: "618021",
    label: "Social contributions paid",
    group: "social",
  },
  {
    systemKey: "company_social_contribution",
    code: "615900",
    label: "Company social contribution",
    group: "social",
  },
  {
    systemKey: "advance_tax_payment",
    code: "670010",
    label: "Advance tax payment",
    group: "advance",
  },
];

/**
 * Attach the systemKeys above to whichever of those accounts exist in this team's
 * chart. Idempotent, and never overwrites a systemKey already set on another
 * account. Returns what was linked and what is missing, because a silently
 * missing account would show as a silently missing number.
 */
export async function linkDirectorAccounts(
  client: PoolClient,
  teamId: string,
): Promise<{ linked: string[]; missing: string[] }> {
  const linked: string[] = [];
  const missing: string[] = [];
  for (const a of DIRECTOR_ACCOUNT_KEYS) {
    const r = await client.query(
      `UPDATE gl_accounts SET system_key = $1
        WHERE team_id = $2 AND code = $3
          AND (system_key IS NULL OR system_key = $1)
        RETURNING code`,
      [a.systemKey, teamId, a.code],
    );
    if (r.rowCount) linked.push(`${a.code}=${a.systemKey}`);
    else missing.push(`${a.code} (${a.label})`);
  }
  return { linked, missing };
}

export type OwnerSummary = {
  director: {
    id: string;
    name: string;
    status: string | null;
    remunerationMonthly: number | null;
    socialInsuranceFund: string | null;
  };
  year: number;
  remuneration: {
    postedYtd: number;
    monthsPosted: number;
    plannedYtd: number | null;
    /** Positive = behind plan. */
    behindPlan: number | null;
  };
  benefits: Array<{ key: string; label: string; amount: number }>;
  benefitsTotal: number;
  withholdingYtd: number;
  socialContributionsYtd: number;
  advancePaymentsYtd: number;
  currentAccount: {
    accountCode: string | null;
    balance: number;
    /** 'credit' the company owes the director, 'debit' the director owes the company. */
    direction: "credit" | "debit" | "zero";
    /** A debit R/C imputes a benefit in kind on the interest: worth flagging early. */
    warning: string | null;
  };
  threshold: {
    remunerationCounted: number;
    value: number;
    pct: number;
    parameter: TaxParameter;
  } | null;
  /** Accounts we expect but did not find in the chart. */
  unmappedAccounts: string[];
};

export async function getOwnerSummary(
  client: { query: PoolClient["query"] },
  input: { teamId: string; directorId: string; year: number },
): Promise<OwnerSummary> {
  const d = await client.query(
    `SELECT d.id, d.name, d.status, d.remuneration_monthly, d.social_insurance_fund,
            a.code AS rc_code, d.gl_account_id
       FROM directors d
       LEFT JOIN gl_accounts a ON a.id = d.gl_account_id
      WHERE d.id = $1 AND d.team_id = $2`,
    [input.directorId, input.teamId],
  );
  if (d.rowCount === 0)
    throw new LedgerError(`director ${input.directorId} not found`);
  const dir = d.rows[0];

  // Posted amounts per systemKey for the year. Expense accounts carry the cost as
  // a debit; the withholding liability and the recovery accounts sit on the credit
  // side, so each group is read in its natural direction.
  const posted = await client.query(
    `SELECT a.system_key,
            SUM(ll.debit)::float8  AS debit,
            SUM(ll.credit)::float8 AS credit,
            COUNT(DISTINCT date_trunc('month', je.date))::int AS months
       FROM ledger_lines ll
       JOIN journal_entries je ON je.id = ll.entry_id AND je.status = 'posted'
       JOIN gl_accounts a ON a.id = ll.account_id
      WHERE ll.team_id = $1
        AND EXTRACT(YEAR FROM je.date) = $2
        AND a.system_key = ANY($3)
      GROUP BY a.system_key`,
    [input.teamId, input.year, DIRECTOR_ACCOUNT_KEYS.map((a) => a.systemKey)],
  );
  const by = new Map(posted.rows.map((r) => [r.system_key as string, r]));
  const debitOf = (key: string) => Number(by.get(key)?.debit ?? 0);
  const creditOf = (key: string) => Number(by.get(key)?.credit ?? 0);

  const postedYtd = debitOf("director_remuneration");
  const monthsPosted = Number(by.get("director_remuneration")?.months ?? 0);
  const plan =
    dir.remuneration_monthly === null ? null : Number(dir.remuneration_monthly);
  // Plan to date: full months elapsed in the year (capped at 12).
  const monthsElapsed =
    input.year < new Date().getFullYear()
      ? 12
      : input.year > new Date().getFullYear()
        ? 0
        : new Date().getMonth() + 1;
  const plannedYtd = plan === null ? null : plan * monthsElapsed;

  const benefits = DIRECTOR_ACCOUNT_KEYS.filter(
    (a) => a.group === "benefit",
  ).map((a) => ({
    key: a.systemKey,
    label: a.label,
    // Benefit charged (debit) minus what the director already repaid (credit on the
    // matching recovery account): what actually lands on the fiche.
    amount: debitOf(a.systemKey) - creditOf(`${a.systemKey}_recovery`),
  }));

  // R/C balance. Liability accounts are credit-normal, so a positive credit balance
  // means the company owes the director.
  let rcBalance = 0;
  if (dir.gl_account_id) {
    const rc = await client.query(
      `SELECT SUM(ll.credit - ll.debit)::float8 AS balance
         FROM ledger_lines ll
         JOIN journal_entries je ON je.id = ll.entry_id AND je.status = 'posted'
        WHERE ll.team_id = $1 AND ll.account_id = $2`,
      [input.teamId, dir.gl_account_id],
    );
    rcBalance = Number(rc.rows[0]?.balance ?? 0);
  }
  const direction =
    rcBalance > 0.005 ? "credit" : rcBalance < -0.005 ? "debit" : "zero";

  let threshold: OwnerSummary["threshold"] = null;
  try {
    const p = await getTaxParameter(
      client,
      input.year,
      "reduced_rate_min_remuneration",
    );
    const counted = postedYtd + benefits.reduce((s, b) => s + b.amount, 0);
    threshold = {
      remunerationCounted: counted,
      value: p.value,
      pct: p.value > 0 ? Math.min(100, (counted / p.value) * 100) : 0,
      parameter: p,
    };
  } catch {
    // Parameter not seeded for this year: show the rest rather than failing the page.
    threshold = null;
  }

  const expected = DIRECTOR_ACCOUNT_KEYS.map((a) => a.systemKey);
  const chart = await client.query(
    `SELECT system_key FROM gl_accounts WHERE team_id = $1 AND system_key = ANY($2)`,
    [input.teamId, expected],
  );
  const inChart = new Set(chart.rows.map((r) => r.system_key as string));
  const unmappedAccounts = DIRECTOR_ACCOUNT_KEYS.filter(
    (a) => !inChart.has(a.systemKey),
  ).map((a) => `${a.code} ${a.label}`);

  return {
    director: {
      id: dir.id,
      name: dir.name,
      status: dir.status,
      remunerationMonthly: plan,
      socialInsuranceFund: dir.social_insurance_fund,
    },
    year: input.year,
    remuneration: {
      postedYtd,
      monthsPosted,
      plannedYtd,
      behindPlan:
        plannedYtd === null ? null : Math.max(0, plannedYtd - postedYtd),
    },
    benefits,
    benefitsTotal: benefits.reduce((s, b) => s + b.amount, 0),
    withholdingYtd: creditOf("director_withholding"),
    socialContributionsYtd:
      debitOf("social_contributions_paid") +
      debitOf("company_social_contribution"),
    advancePaymentsYtd: debitOf("advance_tax_payment"),
    currentAccount: {
      accountCode: dir.rc_code ?? null,
      balance: rcBalance,
      direction,
      warning:
        direction === "debit"
          ? "The current account is in debit: you owe the company. Belgian rules impute a benefit in kind on the interest. Settle it or book the benefit."
          : null,
    },
    threshold,
    unmappedAccounts,
  };
}

export type DirectorRow = {
  id: string;
  name: string;
  status: string | null;
  active: boolean;
  socialInsuranceFund: string | null;
  remunerationMonthly: number | null;
  glAccountCode: string | null;
};

export async function listDirectors(
  client: { query: PoolClient["query"] },
  teamId: string,
): Promise<DirectorRow[]> {
  const r = await client.query(
    `SELECT d.id, d.name, d.status, d.active, d.social_insurance_fund,
            d.remuneration_monthly, a.code AS gl_account_code
       FROM directors d
       LEFT JOIN gl_accounts a ON a.id = d.gl_account_id
      WHERE d.team_id = $1
      ORDER BY d.active DESC, d.name`,
    [teamId],
  );
  return r.rows.map((row) => ({
    id: row.id,
    name: row.name,
    status: row.status,
    active: row.active,
    socialInsuranceFund: row.social_insurance_fund,
    remunerationMonthly:
      row.remuneration_monthly === null
        ? null
        : Number(row.remuneration_monthly),
    glAccountCode: row.gl_account_code,
  }));
}
