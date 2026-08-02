/**
 * Tax parameters: every rate, threshold and coefficient the product computes with,
 * stored as DATA with provenance. Never a literal in code.
 *
 * The point is that any figure on screen can answer two questions: where does this
 * number come from, and when did a human last check it against the source? A
 * parameter without a recent `verifiedOn` renders with a "verify live" badge rather
 * than pretending to be settled.
 */
import type { PoolClient } from "pg";
import { LedgerError } from "./post.js";

export type TaxParameter = {
  year: number;
  key: string;
  value: number;
  unit: string | null;
  sourceUrl: string | null;
  verifiedOn: string | null;
  note: string | null;
  /** True when nobody has checked this against the source within `staleAfterDays`. */
  stale: boolean;
};

const STALE_AFTER_DAYS = 365;

function decorate(row: Record<string, unknown>): TaxParameter {
  const verifiedOn = (row.verified_on as string | null) ?? null;
  const stale =
    !verifiedOn ||
    Date.now() - new Date(verifiedOn).getTime() > STALE_AFTER_DAYS * 86_400_000;
  return {
    year: row.year as number,
    key: row.key as string,
    value: Number(row.value),
    unit: (row.unit as string | null) ?? null,
    sourceUrl: (row.source_url as string | null) ?? null,
    verifiedOn,
    note: (row.note as string | null) ?? null,
    stale,
  };
}

/** Resolve one parameter. Throws when missing: a silent 0 would be a wrong filing. */
export async function getTaxParameter(
  client: { query: PoolClient["query"] },
  year: number,
  key: string,
): Promise<TaxParameter> {
  const r = await client.query(
    `SELECT year, key, value, unit, source_url, verified_on::text AS verified_on, note
       FROM tax_parameters WHERE year = $1 AND key = $2`,
    [year, key],
  );
  if (r.rowCount === 0) {
    throw new LedgerError(
      `tax parameter '${key}' missing for ${year}. Seed it (with a source) before computing anything that depends on it.`,
    );
  }
  return decorate(r.rows[0]);
}

export async function listTaxParameters(
  client: { query: PoolClient["query"] },
  year: number,
): Promise<TaxParameter[]> {
  const r = await client.query(
    `SELECT year, key, value, unit, source_url, verified_on::text AS verified_on, note
       FROM tax_parameters WHERE year = $1 ORDER BY key`,
    [year],
  );
  return r.rows.map(decorate);
}

/**
 * Seed values. Deliberately SMALL: only parameters we can point at a source for.
 *
 * Everything here is seeded with verified_on = NULL, i.e. "taken from the
 * accounting knowledge base, never checked against the authority". The UI shows
 * these as unverified until an operator confirms them against the live source.
 * That is the honest default: a wrong threshold silently applied is worse than a
 * visible "verify this".
 */
export const SEED_PARAMETERS: Array<{
  year: number;
  key: string;
  value: number;
  unit: string;
  sourceUrl: string;
  note: string;
}> = [
  {
    year: 2026,
    key: "reduced_rate_min_remuneration",
    value: 45000,
    unit: "EUR",
    sourceUrl: "https://financien.belgium.be",
    note: "Minimum director remuneration to unlock the reduced corporate rate. A rise to EUR 50.000 has been announced but was not in force for 2026 at the time of seeding. VERIFY before use.",
  },
  {
    year: 2026,
    key: "vat_deadline_day_quarterly",
    value: 25,
    unit: "day",
    sourceUrl: "https://financien.belgium.be/nl/E-services/Intervat",
    note: "Quarterly periodic VAT return due the 25th of the month following the quarter (Intervat technical documentation v14/07/2026).",
  },
  {
    year: 2026,
    key: "vat_deadline_day_monthly",
    value: 20,
    unit: "day",
    sourceUrl: "https://financien.belgium.be/nl/E-services/Intervat",
    note: "Monthly periodic VAT return due the 20th of the following month (same source).",
  },
  {
    year: 2026,
    key: "client_listing_threshold",
    value: 250,
    unit: "EUR",
    sourceUrl: "https://financien.belgium.be",
    note: "Annual customer listing includes Belgian VAT-registered customers above this turnover. VERIFY.",
  },
];

/** Idempotent seed; never overwrites a parameter an operator has verified. */
export async function seedTaxParameters(
  client: PoolClient,
): Promise<{ inserted: number }> {
  let inserted = 0;
  for (const p of SEED_PARAMETERS) {
    const r = await client.query(
      `INSERT INTO tax_parameters (year, key, value, unit, source_url, note)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (year, key) DO NOTHING
       RETURNING id`,
      [p.year, p.key, p.value, p.unit, p.sourceUrl, p.note],
    );
    if ((r.rowCount ?? 0) > 0) inserted++;
  }
  return { inserted };
}
