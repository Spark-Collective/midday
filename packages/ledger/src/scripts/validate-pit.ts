/**
 * Validate the personal-income-tax engine against REAL assessments.
 *
 * The engine is only trustworthy once it reproduces an assessment the authority
 * already issued — the same bar the ledger had to clear against three years of the
 * accountant's closings before it was allowed near live books.
 *
 * Fixtures hold real personal income data, so they live OUTSIDE this repository
 * (which is a public fork). Point the script at a directory of fixture JSON files:
 *
 *   bun run src/scripts/validate-pit.ts ../../../spark-accounting/_validation
 *
 * Each fixture: { incomeYear, municipality, input, expected } — `expected` being
 * the intermediate values the assessment itself prints, so a mismatch says exactly
 * which step diverged rather than just "the total is wrong".
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  computePersonalTax,
  type PitInput,
  type PitParameters,
} from "../personal-tax-compute.js";

/** Parameter sets per income year. Extend as fixtures for new years arrive. */
const PARAMETERS: Record<
  number,
  Omit<PitParameters, "municipalSurchargePct">
> = {
  2024: {
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
    verified: true,
  },
};

const MUNICIPAL_SURCHARGE: Record<string, number> = {
  Antwerpen: 7,
};

type Fixture = {
  incomeYear: number;
  municipality: string;
  input: PitInput;
  expected: Record<string, number>;
};

const dir = process.argv[2];
if (!dir) {
  console.error("usage: bun run src/scripts/validate-pit.ts <fixture-dir>");
  process.exit(2);
}

const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
if (files.length === 0) {
  console.error(`no fixtures in ${dir}`);
  process.exit(2);
}

let failures = 0;
for (const file of files) {
  const fx = JSON.parse(readFileSync(join(dir, file), "utf8")) as Fixture;
  const base = PARAMETERS[fx.incomeYear];
  if (!base) {
    console.error(`${file}: no parameter set for income year ${fx.incomeYear}`);
    failures++;
    continue;
  }
  const municipal = MUNICIPAL_SURCHARGE[fx.municipality];
  if (municipal === undefined) {
    console.error(`${file}: no municipal surcharge for ${fx.municipality}`);
    failures++;
    continue;
  }

  const result = computePersonalTax(
    { ...base, municipalSurchargePct: municipal },
    fx.input,
  );

  console.log(
    `\n=== ${file} (income ${fx.incomeYear}, ${fx.municipality}) ===`,
  );
  let bad = 0;
  for (const [key, expected] of Object.entries(fx.expected)) {
    const actual = (result as unknown as Record<string, number>)[key];
    const ok =
      typeof actual === "number" && Math.abs(actual - expected) < 0.015;
    if (!ok) bad++;
    console.log(
      `  ${ok ? "OK  " : "FAIL"} ${key.padEnd(22)} expected ${expected.toFixed(2).padStart(12)}  got ${
        typeof actual === "number"
          ? actual.toFixed(2).padStart(12)
          : String(actual).padStart(12)
      }`,
    );
  }
  if (bad === 0) {
    console.log(
      `  -> reproduces the assessment exactly (${Object.keys(fx.expected).length} values)`,
    );
  } else {
    failures++;
    console.log(`  -> ${bad} value(s) diverge`);
  }
}

console.log(
  failures === 0
    ? `\nAll ${files.length} assessment(s) reproduced. The engine matches the authority.`
    : `\n${failures} fixture(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
