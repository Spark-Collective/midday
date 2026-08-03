/**
 * Regression: a Bolt invoice for 15.16 (one consolidated invoice covering two
 * rides, 13.90 + 1.26) was offered as a "high_confidence" match against the
 * 13.90 ride alone. Name 0.88 and date 0.85 carried confidence to 0.742 while
 * the amount scored only 0.6, and the confident label invited a one-click
 * confirm that then hid the document as "done".
 *
 * The amount is the decisive signal on a financial document. These assertions
 * pin the floor resolveMatchType now enforces on BOTH confident tiers: below
 * it a pair may be suggested, never auto-matched or labelled high confidence.
 */
import { describe, expect, test } from "bun:test";
import { AUTO_MATCH_MIN_AMOUNT_SCORE } from "../queries/transaction-matching";
import { calculateAmountScore } from "../utils/transaction-matching";

const eur = (amount: number) => ({ amount, currency: "EUR" });

describe("auto-match amount floor", () => {
  test("the real Bolt case scores below the floor", () => {
    // invoice 15.16 vs the single ride it was matched to
    const score = calculateAmountScore(eur(15.16), eur(-13.9));
    expect(score).toBeLessThan(AUTO_MATCH_MIN_AMOUNT_SCORE);
  });

  test("the amounts that legitimately auto-match stay at or above it", () => {
    // exact
    expect(calculateAmountScore(eur(15.16), eur(-15.16))).toBeGreaterThanOrEqual(
      AUTO_MATCH_MIN_AMOUNT_SCORE,
    );
    // rounding / minor fee drift (<=2%)
    expect(calculateAmountScore(eur(100), eur(-101.5))).toBeGreaterThanOrEqual(
      AUTO_MATCH_MIN_AMOUNT_SCORE,
    );
    // exactly at the 5% tier, the loosest score the floor still admits
    expect(calculateAmountScore(eur(100), eur(-105))).toBeGreaterThanOrEqual(
      AUTO_MATCH_MIN_AMOUNT_SCORE,
    );
  });

  test("incl./excl. VAT pairs never reached the VAT fallback anyway", () => {
    // Pre-existing scorer quirk, documented rather than relied on: the
    // percentage tiers return before the COMMON_VAT_RATES branch, because
    // every realistic VAT rate lands under 20% (21% VAT -> 17.4% diff). So a
    // 121/100 pair scores 0.3 and was never an auto-match candidate; the new
    // floor takes nothing away here.
    expect(calculateAmountScore(eur(121), eur(-100))).toBe(0.3);
  });

  test("clearly wrong amounts stay far below it", () => {
    expect(calculateAmountScore(eur(100), eur(-50))).toBeLessThan(
      AUTO_MATCH_MIN_AMOUNT_SCORE,
    );
    expect(calculateAmountScore(eur(15.16), eur(-1.26))).toBeLessThan(
      AUTO_MATCH_MIN_AMOUNT_SCORE,
    );
  });
});
