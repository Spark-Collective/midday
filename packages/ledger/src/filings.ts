/**
 * Compliance filings: the year as a sequence of obligations.
 *
 * One `filings` row per obligation instance. The row drives both the calendar
 * (due_date + status) and the workflow runner (steps jsonb). Generation is
 * idempotent, so the deadline job can run daily without creating duplicates.
 *
 * Design: docs/architecture/midday-compliance-workflows-2026-08-02.md.
 */
import type { PoolClient } from "pg";
import { LedgerError } from "./post.js";

export type FilingKind =
  | "vat_return"
  | "client_listing"
  | "ic_statement"
  | "annual_accounts"
  | "corporate_tax"
  | "personal_tax"
  | "social_contribution"
  | "advance_payment";

export type FilingStatus =
  | "not_started"
  | "in_progress"
  | "ready_for_review"
  | "filed"
  | "confirmed"
  | "skipped";

export type FilingStep = {
  key: string;
  label: string;
  /** 'auto' the system does it, 'human' the operator must act. */
  kind: "auto" | "human";
  status: "todo" | "done" | "blocked" | "skipped";
  doneAt?: string;
  note?: string;
};

/**
 * Step templates per obligation. These are the workflows from the design doc;
 * a filing row snapshots the template at generation time, so changing a template
 * never rewrites history.
 */
export const FILING_TEMPLATES: Record<FilingKind, FilingStep[]> = {
  vat_return: steps([
    ["completeness", "Period completeness check", "auto"],
    ["grids", "Compute grids from the ledger", "auto"],
    ["probability", "Probability pre-check + justification", "human"],
    ["xml", "Build the VATConsignment XML", "auto"],
    ["submit", "Submit to Intervat", "human"],
    ["proof", "Store proof + book the VAT payable", "auto"],
    ["pay", "Pay with the structured communication", "human"],
  ]),
  client_listing: steps([
    ["collect", "Collect Belgian customers above the threshold", "auto"],
    ["review", "Review the client list", "human"],
    ["submit", "Submit to Intervat (type lc)", "human"],
  ]),
  ic_statement: steps([
    ["collect", "Collect intra-EU supplies per customer", "auto"],
    ["review", "Review codes (L / S / T) and amounts", "human"],
    ["submit", "Submit to Intervat (type ico)", "human"],
  ]),
  annual_accounts: steps([
    ["yearend", "Year-end checks (periods closed, bank reconciled)", "auto"],
    ["depreciation", "Depreciation and amortization run", "auto"],
    ["accruals", "Accruals and deferrals review", "human"],
    ["vu", "Disallowed expenses (verworpen uitgaven)", "human"],
    ["tax_estimate", "Estimate corporate tax and book it", "human"],
    ["map", "Map the trial balance to the NBB model", "auto"],
    ["approve", "Approve the accounts (AV minutes)", "human"],
    ["file", "File to the NBB", "human"],
  ]),
  corporate_tax: steps([
    ["base", "Compute the taxable base from the annual accounts", "auto"],
    ["review", "Review adjustments and disallowed expenses", "human"],
    ["file", "File the return (Biztax)", "human"],
  ]),
  personal_tax: steps([
    ["company_side", "Pull remuneration, benefits and withholding", "auto"],
    [
      "official_docs",
      "Pull fiche 281.20 and prior assessment (MyMinfin)",
      "auto",
    ],
    [
      "personal_side",
      "Capture personal items (advance payments, VAPZ, deductions)",
      "human",
    ],
    ["crosscheck", "Cross-check the ledger against the official fiche", "auto"],
    ["compute", "Compute the return and the tax due", "auto"],
    ["review", "Review box by box", "human"],
    ["file", "File (Tax-on-web)", "human"],
    ["assessment", "Reconcile the assessment when it arrives", "auto"],
  ]),
  social_contribution: steps([
    ["amount", "Confirm the provisional amount from the fund", "human"],
    ["pay", "Pay the contribution", "human"],
    ["book", "Match the payment in the ledger", "auto"],
  ]),
  advance_payment: steps([
    ["estimate", "Estimate the advance from the profit forecast", "auto"],
    ["decide", "Decide the amount to pay", "human"],
    ["pay", "Pay before the deadline", "human"],
  ]),
};

function steps(rows: Array<[string, string, "auto" | "human"]>): FilingStep[] {
  return rows.map(([key, label, kind]) => ({
    key,
    label,
    kind,
    status: "todo" as const,
  }));
}

const lastDay = (year: number, month1: number): string => {
  const d = new Date(Date.UTC(year, month1, 0)); // day 0 of next month
  return d.toISOString().slice(0, 10);
};
const day = (year: number, month1: number, dayOfMonth: number): string =>
  `${year}-${String(month1).padStart(2, "0")}-${String(dayOfMonth).padStart(2, "0")}`;

export type CompanyProfile = {
  /** Quarterly is the default Belgian regime for small companies. */
  vatRegime: "quarterly" | "monthly";
  /** Month (1-12) the financial year ends. 12 for a calendar year. */
  fiscalYearEndMonth: number;
  /** Skip kinds the company does not owe (e.g. no intra-EU supplies). */
  skip?: FilingKind[];
};

export const DEFAULT_PROFILE: CompanyProfile = {
  vatRegime: "quarterly",
  fiscalYearEndMonth: 12,
};

/**
 * Deadline rules, in one place so they are auditable.
 *
 * Sources: VAT periodic filing 25th (quarterly) / 20th (monthly) of the month
 * following the period, per the Intervat technical documentation v14/07/2026 §7.
 * Advance-payment dates are the classic 10/04, 10/07, 10/10, 20/12.
 *
 * VERIFY-LIVE: personal-tax and corporate-tax deadlines are announced yearly and
 * shift; annual-accounts timing depends on the general meeting. The generated
 * due date is a starting point the operator can correct on the filing row.
 */
export function computeDueDate(
  kind: FilingKind,
  year: number,
  periodKey: string,
  profile: CompanyProfile,
): string {
  const fyEnd = profile.fiscalYearEndMonth;
  switch (kind) {
    case "vat_return":
    case "ic_statement": {
      if (profile.vatRegime === "monthly") {
        const m = Number(periodKey.slice(5)); // '2026M07'
        return m === 12 ? day(year + 1, 1, 20) : day(year, m + 1, 20);
      }
      const q = Number(periodKey.slice(5)); // '2026Q3'
      return q === 4 ? day(year + 1, 1, 25) : day(year, q * 3 + 1, 25);
    }
    case "client_listing":
      // Annual customer listing: 31 March of the following year.
      return day(year + 1, 3, 31);
    case "social_contribution": {
      // Quarterly to the social insurance fund, due by the end of the quarter.
      const q = Number(periodKey.slice(5));
      return lastDay(year, q * 3);
    }
    case "advance_payment": {
      const q = Number(periodKey.slice(5));
      return [
        day(year, 4, 10),
        day(year, 7, 10),
        day(year, 10, 10),
        day(year, 12, 20),
      ][q - 1]!;
    }
    case "annual_accounts":
      // General meeting within 6 months of FY end, filing within 30 days after.
      return lastDay(year + (fyEnd === 12 ? 1 : 0), ((fyEnd + 7 - 1) % 12) + 1);
    case "corporate_tax":
      // Last day of the seventh month after FY close (verify yearly).
      return lastDay(year + (fyEnd === 12 ? 1 : 0), ((fyEnd + 7 - 1) % 12) + 1);
    case "personal_tax":
      // Tax-on-web deadline, mid-July of the year after the income year (announced yearly).
      return day(year + 1, 7, 15);
  }
}

type GenerateInput = {
  teamId: string;
  year: number;
  profile?: CompanyProfile;
  /** Personal-tax filings are generated per active director. */
  directorIds?: string[];
};

/** Idempotent: safe to run daily. Returns how many rows were newly created. */
export async function generateFilings(
  client: PoolClient,
  input: GenerateInput,
): Promise<{ created: number; kinds: Record<string, number> }> {
  const profile = { ...DEFAULT_PROFILE, ...(input.profile ?? {}) };
  const skip = new Set(profile.skip ?? []);
  const { year, teamId } = input;

  const wanted: Array<{
    kind: FilingKind;
    periodKey: string;
    directorId?: string;
  }> = [];

  const periods =
    profile.vatRegime === "monthly"
      ? Array.from(
          { length: 12 },
          (_, i) => `${year}M${String(i + 1).padStart(2, "0")}`,
        )
      : [1, 2, 3, 4].map((q) => `${year}Q${q}`);
  for (const periodKey of periods) {
    wanted.push({ kind: "vat_return", periodKey });
    wanted.push({ kind: "ic_statement", periodKey });
  }
  for (const q of [1, 2, 3, 4]) {
    wanted.push({ kind: "social_contribution", periodKey: `${year}Q${q}` });
    wanted.push({ kind: "advance_payment", periodKey: `${year}Q${q}` });
  }
  wanted.push({ kind: "client_listing", periodKey: `${year}` });
  wanted.push({ kind: "annual_accounts", periodKey: `${year}` });
  wanted.push({ kind: "corporate_tax", periodKey: `${year}` });
  for (const directorId of input.directorIds ?? []) {
    wanted.push({ kind: "personal_tax", periodKey: `${year}`, directorId });
  }

  let created = 0;
  const kinds: Record<string, number> = {};
  for (const w of wanted) {
    if (skip.has(w.kind)) continue;
    const dueDate = computeDueDate(w.kind, year, w.periodKey, profile);
    const res = await client.query(
      `INSERT INTO filings (team_id, director_id, kind, period_year, period_key, due_date, steps)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        teamId,
        w.directorId ?? null,
        w.kind,
        year,
        w.periodKey,
        dueDate,
        JSON.stringify(FILING_TEMPLATES[w.kind]),
      ],
    );
    if ((res.rowCount ?? 0) > 0) {
      created++;
      kinds[w.kind] = (kinds[w.kind] ?? 0) + 1;
    }
  }
  return { created, kinds };
}

export type FilingRow = {
  id: string;
  kind: FilingKind;
  directorId: string | null;
  directorName: string | null;
  periodYear: number;
  periodKey: string;
  dueDate: string;
  status: FilingStatus;
  steps: FilingStep[];
  data: unknown;
  artifacts: unknown;
  externalRef: string | null;
  filedAt: string | null;
};

export async function listFilings(
  client: { query: PoolClient["query"] },
  input: { teamId: string; year?: number },
): Promise<FilingRow[]> {
  const r = await client.query(
    `SELECT f.id, f.kind, f.director_id, d.name AS director_name, f.period_year,
            f.period_key, f.due_date::text AS due_date, f.status, f.steps, f.data,
            f.artifacts, f.external_ref, f.filed_at::text AS filed_at
       FROM filings f
       LEFT JOIN directors d ON d.id = f.director_id
      WHERE f.team_id = $1 AND ($2::int IS NULL OR f.period_year = $2)
      ORDER BY f.due_date ASC, f.kind ASC`,
    [input.teamId, input.year ?? null],
  );
  return r.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    directorId: row.director_id,
    directorName: row.director_name,
    periodYear: row.period_year,
    periodKey: row.period_key,
    dueDate: row.due_date,
    status: row.status,
    steps: row.steps ?? [],
    data: row.data,
    artifacts: row.artifacts ?? [],
    externalRef: row.external_ref,
    filedAt: row.filed_at,
  }));
}

/** Status rolls up from the steps so the calendar never lies about progress. */
function rollUp(steps: FilingStep[], current: FilingStatus): FilingStatus {
  if (current === "filed" || current === "confirmed" || current === "skipped")
    return current;
  const actionable = steps.filter((s) => s.status !== "skipped");
  const done = actionable.filter((s) => s.status === "done").length;
  if (done === 0) return "not_started";
  if (done === actionable.length) return "ready_for_review";
  return "in_progress";
}

export async function setStep(
  client: PoolClient,
  input: {
    teamId: string;
    filingId: string;
    stepKey: string;
    status: FilingStep["status"];
    note?: string;
  },
): Promise<{ status: FilingStatus; steps: FilingStep[] }> {
  const cur = await client.query(
    `SELECT steps, status FROM filings WHERE id = $1 AND team_id = $2 FOR UPDATE`,
    [input.filingId, input.teamId],
  );
  if (cur.rowCount === 0)
    throw new LedgerError(`filing ${input.filingId} not found`);
  const steps: FilingStep[] = cur.rows[0].steps ?? [];
  const step = steps.find((s) => s.key === input.stepKey);
  if (!step)
    throw new LedgerError(`step '${input.stepKey}' not in this filing`);
  step.status = input.status;
  step.doneAt = input.status === "done" ? new Date().toISOString() : undefined;
  if (input.note !== undefined) step.note = input.note;
  const status = rollUp(steps, cur.rows[0].status);
  await client.query(
    `UPDATE filings SET steps = $1, status = $2 WHERE id = $3`,
    [JSON.stringify(steps), status, input.filingId],
  );
  return { status, steps };
}

/** Record a real submission. Status only becomes 'filed' with evidence. */
export async function markFiled(
  client: PoolClient,
  input: {
    teamId: string;
    filingId: string;
    externalRef: string;
    artifacts?: Array<{ label: string; reference?: string; url?: string }>;
  },
): Promise<void> {
  if (!input.externalRef?.trim()) {
    throw new LedgerError(
      "markFiled needs evidence (externalRef): a proof reference, deposit number or assessment id",
    );
  }
  const r = await client.query(
    `UPDATE filings
        SET status = 'filed', external_ref = $1, filed_at = now(),
            artifacts = COALESCE($2::jsonb, artifacts)
      WHERE id = $3 AND team_id = $4`,
    [
      input.externalRef,
      input.artifacts ? JSON.stringify(input.artifacts) : null,
      input.filingId,
      input.teamId,
    ],
  );
  if (r.rowCount === 0)
    throw new LedgerError(`filing ${input.filingId} not found`);
}

/** Store a computed payload (VAT grids, tax totals) on the filing. */
export async function setFilingData(
  client: PoolClient,
  input: { teamId: string; filingId: string; data: unknown },
): Promise<void> {
  const r = await client.query(
    `UPDATE filings SET data = $1 WHERE id = $2 AND team_id = $3`,
    [JSON.stringify(input.data), input.filingId, input.teamId],
  );
  if (r.rowCount === 0)
    throw new LedgerError(`filing ${input.filingId} not found`);
}
