/**
 * The actual/forecast boundary belongs at TODAY, not at the end of whatever
 * range the user picked.
 *
 * Regression: asking for a range that runs into the future made getRevenue
 * return empty future months labelled "actual", and pushed the forecast to
 * start after them. The chart showed a cliff to zero followed by a recovery,
 * which is exactly how a forecast loses its reader.
 *
 * The boundary is pure date arithmetic, so it is tested as such rather than
 * behind a database.
 */
import { describe, expect, test } from "bun:test";

/** Mirrors getRevenueForecast: history stops at today, forecast starts after. */
function boundary(to: string, today: string) {
  const historicalTo = to < today ? to : today;
  const d = new Date(`${historicalTo}T00:00:00Z`);
  const forecastStartMonth = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1),
  );
  return {
    historicalTo,
    forecastStartsIn: forecastStartMonth.toISOString().slice(0, 7),
  };
}

describe("revenue forecast boundary", () => {
  const today = "2026-08-10";

  test("a range ending in the future is clipped to today", () => {
    const b = boundary("2026-12-31", today);
    expect(b.historicalTo).toBe(today);
    // September, not January: the forecast owns Sep..Dec, not history.
    expect(b.forecastStartsIn).toBe("2026-09");
  });

  test("a range ending in the past is left alone", () => {
    const b = boundary("2026-03-31", today);
    expect(b.historicalTo).toBe("2026-03-31");
    expect(b.forecastStartsIn).toBe("2026-04");
  });

  test("a range ending exactly today keeps today as history", () => {
    const b = boundary(today, today);
    expect(b.historicalTo).toBe(today);
    expect(b.forecastStartsIn).toBe("2026-09");
  });

  test("year boundary rolls over correctly", () => {
    const b = boundary("2026-12-15", "2026-12-15");
    expect(b.forecastStartsIn).toBe("2027-01");
  });
});
