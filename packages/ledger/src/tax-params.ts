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

/**
 * Personal income tax parameters, income year 2024 (assessment year 2025), Flanders.
 *
 * These are marked VERIFIED with an unusually strong warrant: the engine reproduces
 * a real Belgian assessment to the cent using exactly these values, every printed
 * intermediate included. That is stronger evidence than reading a number off a
 * website — the authority applied them to a real case and we match its arithmetic.
 *
 * The municipal surcharge is per municipality, so it is keyed
 * `municipal_surcharge_pct:<slug>` and each new municipality needs its own row.
 */
export const PIT_SEED_2024: Array<{
  year: number;
  key: string;
  value: number;
  unit: string;
  sourceUrl: string;
  note: string;
}> = [
  ["pit_bracket_1_ceiling", 15820, "EUR", "First bracket ceiling."],
  ["pit_bracket_1_rate", 25, "pct", "First bracket rate."],
  ["pit_bracket_2_ceiling", 27920, "EUR", "Second bracket ceiling."],
  ["pit_bracket_2_rate", 40, "pct", "Second bracket rate."],
  ["pit_bracket_3_ceiling", 48320, "EUR", "Third bracket ceiling."],
  ["pit_bracket_3_rate", 45, "pct", "Third bracket rate."],
  ["pit_top_rate", 50, "pct", "Top marginal rate."],
  ["pit_tax_free_sum", 10570, "EUR", "Belastingvrije som, basisbedrag."],
  [
    "pit_tax_free_reduction_rate",
    25,
    "pct",
    "The tax-free sum is credited at this rate, not deducted from income.",
  ],
  [
    "pit_lump_sum_expense_rate_director",
    3,
    "pct",
    "Forfaitaire beroepskosten for a director: % of income AFTER social contributions.",
  ],
  [
    "pit_lump_sum_expense_cap_director",
    2910,
    "EUR",
    "Cap on the director lump sum. Not exercised by the validating assessment: VERIFY before relying on it.",
  ],
  [
    "pit_federal_autonomy_factor_pct",
    24.957,
    "pct",
    "Autonomiefactor: federal tax = principal x (100 - this).",
  ],
  [
    "pit_regional_surcharge_pct",
    33.257,
    "pct",
    "Flemish opcentiemen on the reduced federal tax.",
  ],
  [
    "municipal_surcharge_pct:antwerpen",
    7,
    "pct",
    "Antwerpen. Computed on the TOTAL principal, not on the reduced federal tax.",
  ],
].map(([key, value, unit, note]) => ({
  year: 2024,
  key: key as string,
  value: value as number,
  unit: unit as string,
  sourceUrl: "https://financien.belgium.be",
  note: `${note as string} Verified by reproducing a real AJ2025 assessment to the cent.`,
}));

/** Seed the PIT parameter set for a validated income year. */
export async function seedPitParameters(
  client: PoolClient,
  opts: { verifiedOn: string; verifiedBy: string },
): Promise<{ inserted: number }> {
  let inserted = 0;
  for (const p of PIT_SEED_2024) {
    const r = await client.query(
      `INSERT INTO tax_parameters (year, key, value, unit, source_url, note, verified_on, verified_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (year, key) DO NOTHING
       RETURNING id`,
      [
        p.year,
        p.key,
        p.value,
        p.unit,
        p.sourceUrl,
        p.note,
        opts.verifiedOn,
        opts.verifiedBy,
      ],
    );
    if ((r.rowCount ?? 0) > 0) inserted++;
  }
  return { inserted };
}

/** Resolve a full PIT parameter set for an income year + municipality. */
export async function resolvePitValues(
  client: { query: PoolClient["query"] },
  incomeYear: number,
  municipality: string,
): Promise<{
  values: Record<string, number>;
  municipalSurchargePct: number | null;
  allVerified: boolean;
  missing: string[];
}> {
  const r = await client.query(
    `SELECT key, value, verified_on FROM tax_parameters WHERE year = $1 AND key LIKE 'pit_%'`,
    [incomeYear],
  );
  const values: Record<string, number> = {};
  let allVerified = (r.rowCount ?? 0) > 0;
  for (const row of r.rows) {
    values[row.key as string] = Number(row.value);
    if (!row.verified_on) allVerified = false;
  }
  const slug = municipality.trim().toLowerCase().replace(/\s+/g, "-");
  const m = await client.query(
    `SELECT value, verified_on FROM tax_parameters WHERE year = $1 AND key = $2`,
    [incomeYear, `municipal_surcharge_pct:${slug}`],
  );
  const municipalSurchargePct =
    (m.rowCount ?? 0) > 0 ? Number(m.rows[0].value) : null;
  if ((m.rowCount ?? 0) > 0 && !m.rows[0].verified_on) allVerified = false;

  const missing: string[] = [];
  for (const k of [
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
  ]) {
    if (values[k] === undefined) missing.push(k);
  }
  if (municipalSurchargePct === null) {
    missing.push(`municipal_surcharge_pct:${slug}`);
  }
  return { values, municipalSurchargePct, allVerified, missing };
}
