/**
 * Belastingkrediet voor lage activiteitsinkomsten (art. 289ter WIB 92).
 *
 * Validated against Spark's own Tax-on-Web calculation for aanslagjaar 2026
 * (income 2025): net activity income 24.867,18 produces a credit of 476,60,
 * and closing that gap makes our whole computation reproduce the accountant's
 * "te betalen 239,02" exactly.
 *
 * Indexed bands for aj 2026 (basisbedrag -> geindexeerd):
 *   minimum for a partial credit    3.260 ->  6.550
 *   minimum for the full credit     4.350 ->  8.740
 *   maximum for the full credit    10.880 -> 21.860
 *   maximum for a partial credit   14.140 -> 28.420
 *   the credit itself                 440 ->    880
 */
import { describe, expect, test } from "bun:test";
import {
  computeLowActivityIncomeCredit,
  computePersonalTax,
  type LowActivityIncomeCreditBands,
  type PitParameters,
} from "../src/personal-tax-compute.js";

const AJ2026: LowActivityIncomeCreditBands = {
  partialMin: 6550,
  fullMin: 8740,
  fullMax: 21860,
  partialMax: 28420,
  maxCredit: 880,
};

/** Spark's real parameter set for income year 2025. */
const PARAMS_2025: PitParameters = {
  incomeYear: 2025,
  brackets: [
    { ceiling: 16320, rate: 25 },
    { ceiling: 28800, rate: 40 },
    { ceiling: 49840, rate: 45 },
    { ceiling: Number.POSITIVE_INFINITY, rate: 50 },
  ],
  taxFreeSum: 10910,
  taxFreeReductionRate: 25,
  lumpSumExpenseRate: 3,
  lumpSumExpenseCap: 3130,
  federalAutonomyFactorPct: 24.957,
  regionalSurchargePct: 33.257,
  municipalSurchargePct: 7.5, // Aalst
  lowActivityIncomeCredit: AJ2026,
  verified: true,
};

describe("low activity income credit (art. 289ter)", () => {
  test("the trapezoid: no credit, phase-in, plateau, phase-out", () => {
    expect(computeLowActivityIncomeCredit(AJ2026, 5000)).toBe(0);
    expect(computeLowActivityIncomeCredit(AJ2026, 6550)).toBe(0);
    expect(computeLowActivityIncomeCredit(AJ2026, 8740)).toBe(880);
    expect(computeLowActivityIncomeCredit(AJ2026, 15000)).toBe(880);
    expect(computeLowActivityIncomeCredit(AJ2026, 21860)).toBe(880);
    expect(computeLowActivityIncomeCredit(AJ2026, 28420)).toBe(0);
    expect(computeLowActivityIncomeCredit(AJ2026, 30000)).toBe(0);
    // halfway up the phase-in
    expect(computeLowActivityIncomeCredit(AJ2026, 7645)).toBe(440);
  });

  test("Spark 2025: the credit is 476,60 exactly", () => {
    expect(computeLowActivityIncomeCredit(AJ2026, 24867.18)).toBe(476.6);
  });

  test("omitting the bands applies no credit at all", () => {
    expect(computeLowActivityIncomeCredit(undefined, 24867.18)).toBe(0);
  });

  test("full chain reproduces the accountant's Tax-on-Web: te betalen 239,02", () => {
    const res = computePersonalTax(PARAMS_2025, {
      grossRemuneration: 23613.6,
      benefitsInKind: 7272.71,
      personalSocialContributions: 5250.04,
      withholding: 4413.6,
    });
    // every intermediate the assessment prints
    expect(res.netTaxableIncome).toBe(24867.18);
    expect(res.baseTax).toBe(7498.87);
    expect(res.taxFreeReduction).toBe(2727.5);
    expect(res.totalPrincipal).toBe(4771.37);
    expect(res.federalTax).toBe(3580.58);
    expect(res.regionalTax).toBe(1190.79);
    expect(res.municipalTax).toBe(357.85);
    // withholding 4.413,60 + credit 476,60
    expect(res.totalCredits).toBe(4890.2);
    expect(res.balance).toBe(239.02);
  });

  test("without the credit the balance is 476,60 too high (the old gap)", () => {
    const res = computePersonalTax(
      { ...PARAMS_2025, lowActivityIncomeCredit: undefined },
      {
        grossRemuneration: 23613.6,
        benefitsInKind: 7272.71,
        personalSocialContributions: 5250.04,
        withholding: 4413.6,
      },
    );
    expect(res.balance).toBe(715.62);
    expect(Math.round((res.balance - 239.02) * 100) / 100).toBe(476.6);
  });
});
