/**
 * Personal income tax (personenbelasting) — the computation.
 *
 * The chain below was reverse-engineered from a real Belgian assessment
 * (aanslagbiljet) and reproduces every intermediate value it prints, to the cent:
 * lump-sum expenses, base tax from the progressive brackets, the reduction on the
 * tax-free sum, separately-taxed income, the federal/regional split under the
 * autonomy factor, the municipal surcharge, and the credits.
 *
 * Two rules this module lives by:
 *
 * 1. NO literals. Every rate, bracket and threshold arrives in `PitParameters`,
 *    resolved from the `tax_parameters` table with provenance. A parameter set
 *    that has never been verified against the authority makes the whole result
 *    `unverified`, and the caller must surface that.
 * 2. Full trace. `steps` records each intermediate the way the assessment prints
 *    it, so a human can lay our computation beside the official one line by line.
 *    A tax figure nobody can check is worse than no figure.
 */

export type PitBracket = { ceiling: number; rate: number };

export type PitParameters = {
  incomeYear: number;
  /** Ascending; the last one is the top rate (use Infinity as its ceiling). */
  brackets: PitBracket[];
  taxFreeSum: number;
  /** The tax-free sum is credited at this rate (the first-bracket rate). */
  taxFreeReductionRate: number;
  /** Lump-sum professional expenses for a director: % of income after contributions. */
  lumpSumExpenseRate: number;
  lumpSumExpenseCap: number;
  /** Federal tax is reduced by this % ("autonomiefactor"); the region taxes the rest. */
  federalAutonomyFactorPct: number;
  regionalSurchargePct: number;
  municipalSurchargePct: number;
  /** True when every parameter above has been verified against the source. */
  verified: boolean;
};

export type SeparatelyTaxedIncome = {
  label: string;
  /** Net amount actually taxed (after any cost deduction). */
  net: number;
  rate: number;
  withholding?: number;
};

export type PitInput = {
  grossRemuneration: number;
  benefitsInKind: number;
  /** Personal social contributions — deductible from professional income. */
  personalSocialContributions: number;
  /** When set, used instead of the lump sum. */
  actualExpenses?: number;
  /** Bedrijfsvoorheffing withheld on the remuneration. */
  withholding: number;
  advancePayments?: number;
  /** Roerende voorheffing, tax credits, and anything else refundable. */
  otherCredits?: number;
  separatelyTaxed?: SeparatelyTaxedIncome[];
};

export type PitStep = { label: string; amount: number; note?: string };

export type PitResult = {
  steps: PitStep[];
  netTaxableIncome: number;
  /** Including separately-taxed income; the denominator of the average rate. */
  totalNetIncome: number;
  professionalExpenses: number;
  baseTax: number;
  taxFreeReduction: number;
  taxAfterFreeSum: number;
  separatelyTaxedTax: number;
  totalPrincipal: number;
  federalTax: number;
  regionalTax: number;
  municipalTax: number;
  totalCredits: number;
  /** Positive = to pay, negative = refund. */
  balance: number;
  /** Average rate the assessment prints, for cross-checking. */
  averageRatePct: number;
  /** False when the parameter set was never verified against the authority. */
  verified: boolean;
  warnings: string[];
};

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Progressive tax on an amount, given ascending brackets. */
export function bracketTax(amount: number, brackets: PitBracket[]): number {
  let tax = 0;
  let low = 0;
  for (const b of brackets) {
    if (amount <= low) break;
    tax += (Math.min(amount, b.ceiling) - low) * (b.rate / 100);
    low = b.ceiling;
  }
  return r2(tax);
}

export function computePersonalTax(
  params: PitParameters,
  input: PitInput,
): PitResult {
  const steps: PitStep[] = [];
  const warnings: string[] = [];

  const gross = r2(input.grossRemuneration + input.benefitsInKind);
  steps.push({
    label: "Bezoldigingen (incl. voordelen alle aard)",
    amount: gross,
    note: "code 1400",
  });

  const contributions = r2(input.personalSocialContributions);
  steps.push({
    label: "Persoonlijke sociale bijdragen",
    amount: -contributions,
    note: "code 1405, deductible",
  });

  const afterContributions = r2(gross - contributions);
  let expenses: number;
  if (input.actualExpenses !== undefined) {
    expenses = r2(input.actualExpenses);
    steps.push({ label: "Werkelijke beroepskosten", amount: -expenses });
  } else {
    const lump = r2(afterContributions * (params.lumpSumExpenseRate / 100));
    expenses = Math.min(lump, params.lumpSumExpenseCap);
    if (expenses < lump) {
      steps.push({
        label: "Forfaitaire beroepskosten (geplafonneerd)",
        amount: -expenses,
        note: `${params.lumpSumExpenseRate}% of ${afterContributions.toFixed(2)}, capped at ${params.lumpSumExpenseCap.toFixed(2)}`,
      });
    } else {
      steps.push({
        label: "Forfaitaire beroepskosten",
        amount: -expenses,
        note: `${params.lumpSumExpenseRate}% of ${afterContributions.toFixed(2)}`,
      });
    }
  }

  const netTaxableIncome = r2(afterContributions - expenses);
  steps.push({
    label: "Gezamenlijk belastbaar inkomen",
    amount: netTaxableIncome,
  });

  const baseTax = bracketTax(netTaxableIncome, params.brackets);
  steps.push({ label: "Basisbelasting", amount: baseTax });

  const taxFreeReduction = r2(
    params.taxFreeSum * (params.taxFreeReductionRate / 100),
  );
  steps.push({
    label: "Belastingvermindering op de belastingvrije sommen",
    amount: -taxFreeReduction,
    note: `${params.taxFreeSum.toFixed(2)} x ${params.taxFreeReductionRate}%`,
  });

  const taxAfterFreeSum = r2(baseTax - taxFreeReduction);
  steps.push({ label: "Om te slane belasting", amount: taxAfterFreeSum });

  let separatelyTaxedTax = 0;
  let separateWithholding = 0;
  for (const s of input.separatelyTaxed ?? []) {
    const t = r2(s.net * (s.rate / 100));
    separatelyTaxedTax = r2(separatelyTaxedTax + t);
    separateWithholding = r2(separateWithholding + (s.withholding ?? 0));
    steps.push({
      label: `Afzonderlijk belast: ${s.label}`,
      amount: t,
      note: `${s.net.toFixed(2)} x ${s.rate}%`,
    });
  }

  const totalPrincipal = r2(taxAfterFreeSum + separatelyTaxedTax);
  steps.push({
    label: "Totale hoofdsom (Belasting Staat)",
    amount: totalPrincipal,
  });

  const federalTax = r2(
    totalPrincipal * ((100 - params.federalAutonomyFactorPct) / 100),
  );
  steps.push({
    label: "Gereduceerde Belasting Staat (federaal)",
    amount: federalTax,
    note: `${totalPrincipal.toFixed(2)} x ${(100 - params.federalAutonomyFactorPct).toFixed(3)}%`,
  });

  const regionalTax = r2(federalTax * (params.regionalSurchargePct / 100));
  steps.push({
    label: "Gewestelijke belasting",
    amount: regionalTax,
    note: `${federalTax.toFixed(2)} x ${params.regionalSurchargePct}%`,
  });

  // The municipal surcharge is computed on the TOTAL principal, not on the
  // reduced federal tax. (Confirmed against a real assessment.)
  const municipalTax = r2(
    totalPrincipal * (params.municipalSurchargePct / 100),
  );
  steps.push({
    label: "Gemeentebelasting",
    amount: municipalTax,
    note: `${totalPrincipal.toFixed(2)} x ${params.municipalSurchargePct}%`,
  });

  const totalCredits = r2(
    input.withholding +
      (input.advancePayments ?? 0) +
      (input.otherCredits ?? 0) +
      separateWithholding,
  );
  steps.push({
    label: "Terugbetaalbare bestanddelen (voorheffingen, kredieten)",
    amount: -totalCredits,
  });

  const federalBalance = r2(federalTax - totalCredits);
  const balance = r2(federalBalance + regionalTax + municipalTax);
  steps.push({
    label: balance >= 0 ? "Te betalen" : "Terug te krijgen",
    amount: balance,
  });

  const totalNetIncome = r2(
    netTaxableIncome +
      (input.separatelyTaxed ?? []).reduce((sum, s) => sum + s.net, 0),
  );

  if (!params.verified) {
    warnings.push(
      `The ${params.incomeYear} tax parameters have not been verified against the authority. Treat this computation as an estimate until they are.`,
    );
  }
  if (input.actualExpenses !== undefined) {
    warnings.push(
      "Actual professional expenses were used instead of the lump sum. Make sure they are substantiated.",
    );
  }

  return {
    steps,
    netTaxableIncome,
    totalNetIncome,
    professionalExpenses: expenses,
    baseTax,
    taxFreeReduction,
    taxAfterFreeSum,
    separatelyTaxedTax,
    totalPrincipal,
    federalTax,
    regionalTax,
    municipalTax,
    totalCredits,
    balance,
    // The assessment's "gemiddelde aanslagvoet" divides by TOTAL net income,
    // i.e. including separately-taxed income — not by the jointly-taxed base.
    // (Confirmed against a real assessment: 5.754,24 / 27.219,10 = 21,1%.)
    // The assessment prints this at ONE decimal ("Gemiddelde aanslagvoet 21,1"),
    // so match its precision to keep the two directly comparable.
    averageRatePct:
      totalNetIncome > 0
        ? Math.round((totalPrincipal / totalNetIncome) * 1000) / 10
        : 0,
    verified: params.verified,
    warnings,
  };
}

/**
 * Parameter keys this engine resolves from `tax_parameters`, keyed by INCOME year.
 * `municipal_surcharge_pct` is per municipality: `municipal_surcharge_pct:antwerpen`.
 */
export const PIT_PARAMETER_KEYS = [
  "pit_bracket_1_ceiling",
  "pit_bracket_1_rate",
  "pit_bracket_2_ceiling",
  "pit_bracket_2_rate",
  "pit_bracket_3_ceiling",
  "pit_bracket_3_rate",
  "pit_top_rate",
  "pit_tax_free_sum",
  "pit_tax_free_reduction_rate",
  "pit_lump_sum_expense_rate_director",
  "pit_lump_sum_expense_cap_director",
  "pit_federal_autonomy_factor_pct",
  "pit_regional_surcharge_pct",
] as const;

/** Assemble PitParameters from resolved rows; throws on anything missing. */
export function toPitParameters(
  incomeYear: number,
  values: Record<string, number>,
  municipalSurchargePct: number,
  verified: boolean,
): PitParameters {
  const need = (k: string): number => {
    const v = values[k];
    if (v === undefined) {
      throw new Error(
        `tax parameter '${k}' missing for income year ${incomeYear}; refusing to compute a tax figure on a guess`,
      );
    }
    return v;
  };
  return {
    incomeYear,
    brackets: [
      {
        ceiling: need("pit_bracket_1_ceiling"),
        rate: need("pit_bracket_1_rate"),
      },
      {
        ceiling: need("pit_bracket_2_ceiling"),
        rate: need("pit_bracket_2_rate"),
      },
      {
        ceiling: need("pit_bracket_3_ceiling"),
        rate: need("pit_bracket_3_rate"),
      },
      { ceiling: Number.POSITIVE_INFINITY, rate: need("pit_top_rate") },
    ],
    taxFreeSum: need("pit_tax_free_sum"),
    taxFreeReductionRate: need("pit_tax_free_reduction_rate"),
    lumpSumExpenseRate: need("pit_lump_sum_expense_rate_director"),
    lumpSumExpenseCap: need("pit_lump_sum_expense_cap_director"),
    federalAutonomyFactorPct: need("pit_federal_autonomy_factor_pct"),
    regionalSurchargePct: need("pit_regional_surcharge_pct"),
    municipalSurchargePct,
    verified,
  };
}
