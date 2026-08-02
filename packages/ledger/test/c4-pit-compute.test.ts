/**
 * C4 (computation half): the personal income tax engine.
 *
 * The parameter set and the chain here mirror a real Belgian assessment
 * (income 2024 / AJ2025), but the INCOME FIGURES are synthetic — this repo is a
 * public fork and nobody's assessment belongs in it. The regression against a real
 * assessment runs separately from a gitignored fixture; see
 * `scripts/validate-pit.ts` and spark-accounting/ in the workspace.
 */
import { describe, expect, test } from "bun:test";
import {
  bracketTax,
  computePersonalTax,
  type PitParameters,
  toPitParameters,
} from "../src/personal-tax-compute.js";

/** Income year 2024 (assessment year 2025), Flanders. */
const PARAMS_2024: PitParameters = {
  incomeYear: 2024,
  brackets: [
    { ceiling: 15820, rate: 25 },
    { ceiling: 27920, rate: 40 },
    { ceiling: 48320, rate: 45 },
    { ceiling: Number.POSITIVE_INFINITY, rate: 50 },
  ],
  taxFreeSum: 10570,
  taxFreeReductionRate: 25,
  lumpSumExpenseRate: 3,
  lumpSumExpenseCap: 2910,
  federalAutonomyFactorPct: 24.957,
  regionalSurchargePct: 33.257,
  municipalSurchargePct: 7,
  verified: true,
};

describe("progressive brackets", () => {
  test("taxes each slice at its own rate", () => {
    // Entirely in the first bracket.
    expect(bracketTax(10000, PARAMS_2024.brackets)).toBe(2500);
    // Exactly at the first ceiling.
    expect(bracketTax(15820, PARAMS_2024.brackets)).toBe(3955);
    // Spanning two brackets: 3.955 + 40% of the excess.
    expect(bracketTax(20000, PARAMS_2024.brackets)).toBe(3955 + 0.4 * 4180);
    // Into the top rate.
    const top = bracketTax(60000, PARAMS_2024.brackets);
    expect(top).toBeCloseTo(3955 + 4840 + 9180 + 5840, 2);
  });

  test("zero income is zero tax", () => {
    expect(bracketTax(0, PARAMS_2024.brackets)).toBe(0);
  });
});

describe("full computation chain", () => {
  // Synthetic, but shaped like a real director's year.
  const input = {
    grossRemuneration: 30000,
    benefitsInKind: 0,
    personalSocialContributions: 3500,
    withholding: 4000,
    otherCredits: 0,
  };

  test("lump-sum expenses are 3% of income after contributions", () => {
    const r = computePersonalTax(PARAMS_2024, input);
    // 3% of (30.000 - 3.500) = 795
    expect(r.professionalExpenses).toBe(795);
    expect(r.netTaxableIncome).toBe(25705);
  });

  test("the lump sum is capped", () => {
    const r = computePersonalTax(PARAMS_2024, {
      ...input,
      grossRemuneration: 200000,
    });
    expect(r.professionalExpenses).toBe(PARAMS_2024.lumpSumExpenseCap);
    expect(
      r.steps.find((s) => s.label.includes("geplafonneerd")),
    ).toBeDefined();
  });

  test("actual expenses override the lump sum, with a warning", () => {
    const r = computePersonalTax(PARAMS_2024, {
      ...input,
      actualExpenses: 5000,
    });
    expect(r.professionalExpenses).toBe(5000);
    expect(r.warnings.join(" ")).toContain("Actual professional expenses");
  });

  test("the tax-free sum is credited at its own rate, not deducted from income", () => {
    const r = computePersonalTax(PARAMS_2024, input);
    expect(r.taxFreeReduction).toBe(2642.5); // 10.570 x 25%
    expect(r.taxAfterFreeSum).toBe(r.baseTax - 2642.5);
  });

  test("federal, regional and municipal are layered in the right order", () => {
    const r = computePersonalTax(PARAMS_2024, input);
    // Federal = principal x (100 - autonomy factor)
    expect(r.federalTax).toBeCloseTo(r.totalPrincipal * 0.75043, 1);
    // Regional is a surcharge ON the reduced federal tax...
    expect(r.regionalTax).toBeCloseTo(r.federalTax * 0.33257, 1);
    // ...but the municipal surcharge is on the TOTAL principal.
    expect(r.municipalTax).toBeCloseTo(r.totalPrincipal * 0.07, 1);
  });

  test("separately taxed income is added to the principal and its withholding credited", () => {
    const withSeparate = computePersonalTax(PARAMS_2024, {
      ...input,
      separatelyTaxed: [
        { label: "Deeleconomie", net: 500, rate: 20, withholding: 100 },
      ],
    });
    const plain = computePersonalTax(PARAMS_2024, input);
    expect(withSeparate.separatelyTaxedTax).toBe(100); // 500 x 20%
    expect(withSeparate.totalPrincipal).toBe(plain.totalPrincipal + 100);
    // Its withholding lands in the credits.
    expect(withSeparate.totalCredits).toBe(plain.totalCredits + 100);
  });

  test("the balance is federal-after-credits plus regional plus municipal", () => {
    const r = computePersonalTax(PARAMS_2024, input);
    const expected =
      Math.round(
        (r.federalTax - r.totalCredits + r.regionalTax + r.municipalTax) * 100,
      ) / 100;
    expect(r.balance).toBe(expected);
  });

  test("over-withholding produces a refund, not a negative payment", () => {
    const r = computePersonalTax(PARAMS_2024, { ...input, withholding: 20000 });
    expect(r.balance).toBeLessThan(0);
    expect(r.steps.at(-1)?.label).toBe("Terug te krijgen");
  });

  test("every step is traceable", () => {
    const r = computePersonalTax(PARAMS_2024, input);
    for (const label of [
      "Gezamenlijk belastbaar inkomen",
      "Basisbelasting",
      "Om te slane belasting",
      "Totale hoofdsom (Belasting Staat)",
      "Gemeentebelasting",
    ]) {
      expect(r.steps.some((s) => s.label === label)).toBe(true);
    }
  });
});

describe("parameter discipline", () => {
  test("unverified parameters make the whole result unverified", () => {
    const r = computePersonalTax(
      { ...PARAMS_2024, verified: false },
      {
        grossRemuneration: 30000,
        benefitsInKind: 0,
        personalSocialContributions: 3500,
        withholding: 0,
      },
    );
    expect(r.verified).toBe(false);
    expect(r.warnings.join(" ")).toContain("not been verified");
  });

  test("a missing parameter refuses to compute rather than guessing", () => {
    expect(() =>
      toPitParameters(2024, { pit_bracket_1_ceiling: 15820 }, 7, true),
    ).toThrow(/missing for income year 2024/);
  });

  test("toPitParameters assembles a usable set", () => {
    const values: Record<string, number> = {
      pit_bracket_1_ceiling: 15820,
      pit_bracket_1_rate: 25,
      pit_bracket_2_ceiling: 27920,
      pit_bracket_2_rate: 40,
      pit_bracket_3_ceiling: 48320,
      pit_bracket_3_rate: 45,
      pit_top_rate: 50,
      pit_tax_free_sum: 10570,
      pit_tax_free_reduction_rate: 25,
      pit_lump_sum_expense_rate_director: 3,
      pit_lump_sum_expense_cap_director: 2910,
      pit_federal_autonomy_factor_pct: 24.957,
      pit_regional_surcharge_pct: 33.257,
    };
    const p = toPitParameters(2024, values, 7, true);
    expect(p.brackets.length).toBe(4);
    expect(p.brackets.at(-1)?.ceiling).toBe(Number.POSITIVE_INFINITY);
    expect(
      computePersonalTax(p, {
        grossRemuneration: 30000,
        benefitsInKind: 0,
        personalSocialContributions: 3500,
        withholding: 4000,
      }).netTaxableIncome,
    ).toBe(25705);
  });
});
