/**
 * Direction guard (M12-P0): the scorer compares Math.abs() of both amounts,
 * so before this guard a -113.72 credit note scored identically against a
 * +113.72 refund and a -113.72 payment. The trigger case is the Combell
 * creditnota 260807528: with a strong name and date match it could reach a
 * confident tier against the *payment* of a similar amount, inviting a
 * one-click confirm of a backwards pairing.
 *
 * Convention (every matched pair in production): inbox documents are
 * positive for invoices/receipts, transactions are negative for payments.
 * So agreement = opposite signs; a credit note (negative) agrees only with
 * a refund inflow (positive).
 */
import { describe, expect, test } from "bun:test";
import { matchDirectionAgrees } from "../queries/transaction-matching";

describe("match direction guard", () => {
  test("invoice (+) settles by outflow (-): agrees", () => {
    expect(matchDirectionAgrees(170.57, -170.57)).toBe(true);
  });

  test("credit note (-) settles by refund inflow (+): agrees", () => {
    expect(matchDirectionAgrees(-113.72, 113.72)).toBe(true);
  });

  test("credit note (-) against a payment (-): refused", () => {
    expect(matchDirectionAgrees(-113.72, -113.72)).toBe(false);
  });

  test("invoice (+) against an inflow (+): refused", () => {
    expect(matchDirectionAgrees(170.57, 170.57)).toBe(false);
  });

  test("missing or zero amounts carry no direction signal", () => {
    expect(matchDirectionAgrees(null, -50)).toBe(true);
    expect(matchDirectionAgrees(50, undefined)).toBe(true);
    expect(matchDirectionAgrees(0, -50)).toBe(true);
  });
});
