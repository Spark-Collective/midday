/**
 * Personal income tax (personenbelasting), step 1: ASSEMBLY.
 *
 * This module collects everything that goes into a director's return and maps it
 * to the boxes of the Belgian form. It deliberately does NOT compute the tax due.
 *
 * Why the split: the collection side is verifiable today (every figure traces to a
 * posted ledger line or an item the operator entered, and the totals can be checked
 * against the official fiche 281.20). The computation side — brackets, tax-free sum,
 * regional competences, municipal surcharge — cannot be trusted until it reproduces
 * a real assessment, exactly as the ledger was not trusted until it reproduced three
 * years of the accountant's closings. `computePersonalTax` lands in the same package
 * once that validation harness exists (see docs/architecture/
 * midday-compliance-workflows-2026-08-02.md §3).
 *
 * Producing a plausible-but-unvalidated tax figure would be the single most harmful
 * thing this product could do, so it is not offered at all yet.
 */
import type { PoolClient } from "pg";
import { DIRECTOR_ACCOUNT_KEYS } from "./owner.js";
import { LedgerError } from "./post.js";

/**
 * Boxes of the Belgian personal income tax return relevant to a company director.
 * Codes are the official "vak / code" identifiers.
 *
 * VERIFY-LIVE: box codes are stable year to year but not guaranteed; confirm
 * against the actual form for the income year before filing.
 */
export const DIRECTOR_BOXES = {
  /** Vak XVI — Bezoldigingen van bedrijfsleiders. Gross remuneration. */
  remuneration: {
    vak: "XVI",
    code: "1400",
    label: "Bezoldigingen bedrijfsleider",
  },
  /** Benefits in kind, reported inside the same box as remuneration. */
  benefitsInKind: { vak: "XVI", code: "1400", label: "Voordelen alle aard" },
  /** Bedrijfsvoorheffing already withheld by the company.
   *  Code 1407, not 1225: 1225 is the employee box in vak IV. Verified against
   *  Spark's Tax-on-Web calculation for aanslagjaar 2026 (income 2025), which
   *  reports the director's bedrijfsvoorheffing under 1407. */
  withholding: {
    vak: "XVI",
    code: "1407",
    label: "Ingehouden bedrijfsvoorheffing",
  },
  /** Social contributions paid personally — deductible professional expense. */
  socialContributions: { vak: "XVI", code: "1405", label: "Sociale bijdragen" },
  /** Actual professional expenses, if not using the lump sum. */
  actualExpenses: {
    vak: "XVI",
    code: "1406",
    label: "Werkelijke beroepskosten",
  },
  /** VAPZ premium — deductible. */
  vapz: { vak: "XVI", code: "1405", label: "VAPZ-premie" },
  /** Advance payments made personally. */
  advancePayments: { vak: "XIII", code: "1570", label: "Voorafbetalingen" },
} as const;

export type PersonalTaxLine = {
  boxKey: keyof typeof DIRECTOR_BOXES;
  vak: string;
  code: string;
  label: string;
  amount: number;
  /** Where the number came from, so every figure is defensible. */
  source: "ledger" | "director_item" | "official_fiche";
  /** The systemKeys or item kinds that produced it. */
  basis: string[];
};

export type PersonalTaxPack = {
  directorId: string;
  directorName: string;
  /** The INCOME year. The assessment year (aanslagjaar) is this + 1. */
  incomeYear: number;
  assessmentYear: number;
  lines: PersonalTaxLine[];
  totals: {
    grossProfessionalIncome: number;
    deductibleContributions: number;
    withholding: number;
    advancePayments: number;
  };
  /** Anything the operator must resolve before this pack is complete. */
  gaps: string[];
};

const BENEFIT_KEYS = DIRECTOR_ACCOUNT_KEYS.filter(
  (a) => a.group === "benefit",
).map((a) => a.systemKey);

/**
 * Assemble the pack from the company ledger + the director's personal items.
 * Every line carries its source and basis; nothing is inferred silently.
 */
export async function buildPersonalTaxPack(
  client: { query: PoolClient["query"] },
  input: { teamId: string; directorId: string; incomeYear: number },
): Promise<PersonalTaxPack> {
  const d = await client.query(
    `SELECT id, name FROM directors WHERE id = $1 AND team_id = $2`,
    [input.directorId, input.teamId],
  );
  if (d.rowCount === 0)
    throw new LedgerError(`director ${input.directorId} not found`);

  const posted = await client.query(
    `SELECT a.system_key,
            SUM(ll.debit)::float8  AS debit,
            SUM(ll.credit)::float8 AS credit
       FROM ledger_lines ll
       JOIN journal_entries je ON je.id = ll.entry_id AND je.status = 'posted'
       JOIN gl_accounts a ON a.id = ll.account_id
      WHERE ll.team_id = $1
        AND EXTRACT(YEAR FROM je.date) = $2
        AND a.system_key = ANY($3)
      GROUP BY a.system_key`,
    [
      input.teamId,
      input.incomeYear,
      DIRECTOR_ACCOUNT_KEYS.map((a) => a.systemKey),
    ],
  );
  const by = new Map(posted.rows.map((r) => [r.system_key as string, r]));
  const debitOf = (k: string) => Number(by.get(k)?.debit ?? 0);
  const creditOf = (k: string) => Number(by.get(k)?.credit ?? 0);

  const items = await client.query(
    `SELECT kind, SUM(amount)::float8 AS amount
       FROM director_items
      WHERE team_id = $1 AND director_id = $2 AND year = $3
      GROUP BY kind`,
    [input.teamId, input.directorId, input.incomeYear],
  );
  const itemOf = (kind: string) =>
    Number(items.rows.find((r) => r.kind === kind)?.amount ?? 0);

  const lines: PersonalTaxLine[] = [];
  const push = (
    boxKey: keyof typeof DIRECTOR_BOXES,
    amount: number,
    source: PersonalTaxLine["source"],
    basis: string[],
  ) => {
    if (amount === 0) return;
    const box = DIRECTOR_BOXES[boxKey];
    lines.push({
      boxKey,
      ...box,
      amount: Math.round(amount * 100) / 100,
      source,
      basis,
    });
  };

  const remuneration = debitOf("director_remuneration");
  push("remuneration", remuneration, "ledger", ["director_remuneration"]);

  // Benefits in kind are taxable GROSS. The company books each benefit as a
  // cost and contras it to a 746xxx recovery so the payroll journal balances
  // and the P&L nets to zero, but that contra is bookkeeping, not a payment by
  // the director: the fiche 281.20 reports the benefit in full.
  //
  // Proven against Spark's 2024 fiche (code 400 = 31.046,33):
  //   618000 remuneration              25.312,60
  //   VAA car/phone/pc/internet         2.140,61   <- was netted to 0 before
  //   618020 social contributions borne 3.593,12   <- was not mapped at all
  //                                    ----------
  //                                    31.046,33   = fiche code 400 exactly
  //
  // A genuine eigen bijdrage (the director actually paying for the benefit)
  // does reduce the taxable amount, but it is booked against the director's
  // R/C, not to a recovery account, so it never lands here.
  const benefits = BENEFIT_KEYS.reduce(
    (s, k) => s + debitOf(k) - creditOf(k),
    0,
  );
  push("benefitsInKind", benefits, "ledger", BENEFIT_KEYS);

  const withholding = creditOf("director_withholding");
  push("withholding", withholding, "ledger", ["director_withholding"]);

  // Social contributions paid BY the company on the director's behalf are already
  // in the company books; premiums the director paid privately live in director_items.
  const socialLedger = debitOf("social_contributions_paid");
  const socialPersonal = itemOf("social_contribution_personal");
  push("socialContributions", socialLedger + socialPersonal, "ledger", [
    "social_contributions_paid",
    "director_items:social_contribution_personal",
  ]);

  push("vapz", itemOf("vapz_premium"), "director_item", ["vapz_premium"]);
  push("actualExpenses", itemOf("actual_expenses"), "director_item", [
    "actual_expenses",
  ]);

  // Advance payments: the company's own prepayments are corporate tax, NOT the
  // director's. Only personally-made prepayments belong in the personal return.
  const advancePersonal = itemOf("personal_advance_payment");
  push("advancePayments", advancePersonal, "director_item", [
    "personal_advance_payment",
  ]);

  const gaps: string[] = [];
  if (remuneration === 0) {
    gaps.push(
      `No director remuneration posted for ${input.incomeYear}. Either nothing was paid, or account 618000 is not linked (Owner > link standard accounts).`,
    );
  }
  if (withholding === 0 && remuneration > 0) {
    gaps.push(
      "Remuneration was paid but no withholding (bedrijfsvoorheffing) is booked. Check account 453000.",
    );
  }
  if (advancePersonal === 0) {
    gaps.push(
      "No personal advance payments recorded. If you paid any personally, add them under Owner so they are credited.",
    );
  }
  gaps.push(
    "Cross-check against the official fiche 281.20 before filing: the company ledger is our number, the fiche is theirs.",
  );

  return {
    directorId: input.directorId,
    directorName: d.rows[0].name,
    incomeYear: input.incomeYear,
    assessmentYear: input.incomeYear + 1,
    lines,
    totals: {
      grossProfessionalIncome:
        Math.round((remuneration + benefits) * 100) / 100,
      deductibleContributions:
        Math.round(
          (socialLedger + socialPersonal + itemOf("vapz_premium")) * 100,
        ) / 100,
      withholding: Math.round(withholding * 100) / 100,
      advancePayments: Math.round(advancePersonal * 100) / 100,
    },
    gaps,
  };
}

/**
 * Compare our assembled figures against the official fiche 281.20 (or a prior
 * assessment). Any difference is surfaced, never reconciled away: if the authority
 * and our ledger disagree, a human decides which is wrong.
 */
export function comparePackToOfficial(
  pack: PersonalTaxPack,
  official: {
    grossRemuneration?: number;
    benefitsInKind?: number;
    withholding?: number;
  },
): Array<{ field: string; ours: number; theirs: number; difference: number }> {
  const ours = {
    grossRemuneration:
      pack.lines.find((l) => l.boxKey === "remuneration")?.amount ?? 0,
    benefitsInKind:
      pack.lines.find((l) => l.boxKey === "benefitsInKind")?.amount ?? 0,
    withholding:
      pack.lines.find((l) => l.boxKey === "withholding")?.amount ?? 0,
  };
  const out: Array<{
    field: string;
    ours: number;
    theirs: number;
    difference: number;
  }> = [];
  for (const [field, theirs] of Object.entries(official)) {
    if (theirs === undefined) continue;
    const mine = ours[field as keyof typeof ours] ?? 0;
    const difference = Math.round((mine - theirs) * 100) / 100;
    if (Math.abs(difference) >= 0.01) {
      out.push({ field, ours: mine, theirs, difference });
    }
  }
  return out;
}
