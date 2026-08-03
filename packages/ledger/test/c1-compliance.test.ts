/**
 * C1 acceptance: the filings layer (generation is idempotent, deadlines follow the
 * documented rules, status rolls up from steps, "filed" requires evidence), the
 * Intervat probability rules, and tax-parameter provenance.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Pool, type PoolClient } from "pg";
import {
  computeDueDate,
  generateFilings,
  listFilings,
  markFiled,
  setStep,
  skipFiling,
} from "../src/filings.js";
import {
  getTaxParameter,
  listTaxParameters,
  seedTaxParameters,
} from "../src/tax-params.js";
import { checkVatProbabilityRules } from "../src/vat-checks.js";
import { expectError, initTestDb, TEST_DB_URL } from "./helpers/setup.js";

const pool = new Pool({ connectionString: TEST_DB_URL });
let db: PoolClient;
let teamId: string;
let directorId: string;

beforeAll(async () => {
  db = await pool.connect();
  teamId = await initTestDb(db);
  const d = await db.query(
    `INSERT INTO directors (team_id, name, municipality) VALUES ($1, 'Test Director', 'Antwerpen') RETURNING id`,
    [teamId],
  );
  directorId = d.rows[0].id;
});

afterAll(async () => {
  db?.release();
  await pool.end();
});

describe("deadline rules (C1)", () => {
  const profile = { vatRegime: "quarterly" as const, fiscalYearEndMonth: 12 };

  test("quarterly VAT is due the 25th of the month after the quarter", () => {
    // Intervat technical documentation v14/07/2026 §7.
    expect(computeDueDate("vat_return", 2026, "2026Q1", profile)).toBe(
      "2026-04-25",
    );
    expect(computeDueDate("vat_return", 2026, "2026Q3", profile)).toBe(
      "2026-10-25",
    );
    // Q4 rolls into the next year.
    expect(computeDueDate("vat_return", 2026, "2026Q4", profile)).toBe(
      "2027-01-25",
    );
  });

  test("monthly VAT is due the 20th of the following month", () => {
    const monthly = { ...profile, vatRegime: "monthly" as const };
    expect(computeDueDate("vat_return", 2026, "2026M07", monthly)).toBe(
      "2026-08-20",
    );
    expect(computeDueDate("vat_return", 2026, "2026M12", monthly)).toBe(
      "2027-01-20",
    );
  });

  test("advance payments follow 10/04, 10/07, 10/10, 20/12", () => {
    const days = [1, 2, 3, 4].map((q) =>
      computeDueDate("advance_payment", 2026, `2026Q${q}`, profile),
    );
    expect(days).toEqual([
      "2026-04-10",
      "2026-07-10",
      "2026-10-10",
      "2026-12-20",
    ]);
  });

  test("social contributions are due at the end of each quarter", () => {
    expect(computeDueDate("social_contribution", 2026, "2026Q1", profile)).toBe(
      "2026-03-31",
    );
    expect(computeDueDate("social_contribution", 2026, "2026Q4", profile)).toBe(
      "2026-12-31",
    );
  });

  test("annual obligations land after the financial year closes", () => {
    expect(computeDueDate("client_listing", 2026, "2026", profile)).toBe(
      "2027-03-31",
    );
    expect(computeDueDate("annual_accounts", 2026, "2026", profile)).toBe(
      "2027-07-31",
    );
    expect(computeDueDate("personal_tax", 2026, "2026", profile)).toBe(
      "2027-07-15",
    );
  });
});

describe("filing generation (C1)", () => {
  test("generates the year and is idempotent", async () => {
    const first = await generateFilings(db, {
      teamId,
      year: 2026,
      directorIds: [directorId],
    });
    // 4 VAT + 4 ICO + 4 social + 4 advance + listing + accounts + corporate + 1 personal
    expect(first.created).toBe(20);
    expect(first.kinds.vat_return).toBe(4);
    expect(first.kinds.personal_tax).toBe(1);

    const second = await generateFilings(db, {
      teamId,
      year: 2026,
      directorIds: [directorId],
    });
    expect(second.created).toBe(0); // safe to run daily

    const rows = await listFilings(db, { teamId, year: 2026 });
    expect(rows.length).toBe(20);
    // sorted by due date: the first advance payment (10 Apr) precedes VAT Q1 (25 Apr)
    expect(rows[0]?.dueDate).toBe("2026-03-31");
    expect(rows.every((r) => r.status === "not_started")).toBe(true);
    expect(rows.find((r) => r.kind === "personal_tax")?.directorName).toBe(
      "Test Director",
    );
  });

  test("a second director gets their own personal-tax filing", async () => {
    const d2 = await db.query(
      `INSERT INTO directors (team_id, name) VALUES ($1, 'Second Director') RETURNING id`,
      [teamId],
    );
    const res = await generateFilings(db, {
      teamId,
      year: 2026,
      directorIds: [directorId, d2.rows[0].id],
    });
    expect(res.created).toBe(1); // only the new director's personal tax
    const personal = (await listFilings(db, { teamId, year: 2026 })).filter(
      (r) => r.kind === "personal_tax",
    );
    expect(personal.length).toBe(2);
  });

  test("skip list drops obligations the company does not owe", async () => {
    const res = await generateFilings(db, {
      teamId,
      year: 2027,
      profile: {
        vatRegime: "quarterly",
        fiscalYearEndMonth: 12,
        skip: ["ic_statement", "advance_payment"],
      },
    });
    const kinds = (await listFilings(db, { teamId, year: 2027 })).map(
      (r) => r.kind,
    );
    expect(kinds).not.toContain("ic_statement");
    expect(kinds).not.toContain("advance_payment");
    expect(res.created).toBe(11);
  });
});

describe("workflow progress (C1)", () => {
  test("status rolls up from the steps", async () => {
    const vat = (await listFilings(db, { teamId, year: 2026 })).find(
      (r) => r.kind === "vat_return" && r.periodKey === "2026Q3",
    )!;
    expect(vat.steps.length).toBe(7);
    expect(vat.status).toBe("not_started");

    const a = await setStep(db, {
      teamId,
      filingId: vat.id,
      stepKey: "completeness",
      status: "done",
    });
    expect(a.status).toBe("in_progress");
    expect(a.steps.find((s) => s.key === "completeness")?.doneAt).toBeTruthy();

    for (const key of [
      "grids",
      "probability",
      "xml",
      "submit",
      "proof",
      "pay",
    ]) {
      await setStep(db, {
        teamId,
        filingId: vat.id,
        stepKey: key,
        status: "done",
      });
    }
    const all = await listFilings(db, { teamId, year: 2026 });
    expect(all.find((r) => r.id === vat.id)?.status).toBe("ready_for_review");
  });

  test("an unknown step is rejected", async () => {
    const vat = (await listFilings(db, { teamId, year: 2026 })).find(
      (r) => r.kind === "vat_return" && r.periodKey === "2026Q1",
    )!;
    await expectError(
      setStep(db, {
        teamId,
        filingId: vat.id,
        stepKey: "nope",
        status: "done",
      }),
      /not in this filing/,
    );
  });

  test("'filed' requires evidence, and survives further step edits", async () => {
    const vat = (await listFilings(db, { teamId, year: 2026 })).find(
      (r) => r.kind === "vat_return" && r.periodKey === "2026Q2",
    )!;
    await expectError(
      markFiled(db, { teamId, filingId: vat.id, externalRef: "  " }),
      /needs evidence/,
    );
    await markFiled(db, {
      teamId,
      filingId: vat.id,
      externalRef: "dd346737-f0fc-4bb2-8609-52713653b154",
      artifacts: [{ label: "Intervat proof (PDF)", reference: "dd346737" }],
    });
    const after = (await listFilings(db, { teamId, year: 2026 })).find(
      (r) => r.id === vat.id,
    )!;
    expect(after.status).toBe("filed");
    expect(after.filedAt).toBeTruthy();

    // Editing a step must not silently un-file a filed return.
    const rolled = await setStep(db, {
      teamId,
      filingId: vat.id,
      stepKey: "pay",
      status: "done",
    });
    expect(rolled.status).toBe("filed");
  });

  test("'skipped' also demands a reason, and stops counting as overdue", async () => {
    const ic = (await listFilings(db, { teamId, year: 2026 })).find(
      (r) => r.kind === "ic_statement" && r.periodKey === "2026Q1",
    )!;
    await expectError(
      skipFiling(db, { teamId, filingId: ic.id, reason: " " }),
      /needs a reason/,
    );
    await skipFiling(db, {
      teamId,
      filingId: ic.id,
      reason: "No intra-Community supplies in this quarter.",
    });
    const after = (await listFilings(db, { teamId, year: 2026 })).find(
      (r) => r.id === ic.id,
    )!;
    expect(after.status).toBe("skipped");
    expect(after.externalRef).toContain("No intra-Community");
    // A skipped obligation was never filed: no false filing date.
    expect(after.filedAt).toBeFalsy();
  });
});

describe("Intervat probability rules (C2)", () => {
  test("a clean return trips nothing", () => {
    // 1000 revenue at 21%: grid 03 = 1000, 54 = 210, 71 = 210.
    expect(
      checkVatProbabilityRules({
        "03": "1000.00",
        "54": "210.00",
        "71": "210.00",
      }),
    ).toEqual([]);
  });

  test("rule 4 catches the scenario we filed in ACC (86/88 without 55)", () => {
    const w = checkVatProbabilityRules({ "86": "1000.00", "71": "500.00" });
    expect(w.map((x) => x.code)).toContain("W_TVA_GRID_55_INCORRECT_VALUE");
  });

  test("rule 1 catches VAT in 54 that does not match the rates in 01/02/03", () => {
    // 21% of 1000 is 210; declaring 100 is 110 short, above the 62 tolerance.
    const w = checkVatProbabilityRules({ "03": "1000.00", "54": "100.00" });
    expect(w.map((x) => x.code)).toContain("W_TVA_GRID_54O_INCORRECT_VALUE");
    // ...but a small rounding difference stays under the tolerance.
    expect(
      checkVatProbabilityRules({ "03": "1000.00", "54": "150.00" }).map(
        (x) => x.code,
      ),
    ).not.toContain("W_TVA_GRID_54O_INCORRECT_VALUE");
  });

  test("rule 2 catches an amount in 87 with no VAT in 56/57", () => {
    const w = checkVatProbabilityRules({ "87": "1000.00" });
    expect(w.map((x) => x.code)).toContain("W_TVA_GRID_5657_INCORRECT_VALUE");
  });

  test("rule 5 uses the corrected 3.000,00 threshold, not the documented typo", () => {
    // base 81..85 = 10.000 -> 21% = 2.100. A deduction of 5.500 gives TEST = 3.400,
    // which is over 3.000 AND over 5% of the base, so it must trigger.
    const w = checkVatProbabilityRules({ "81": "10000.00", "59": "5500.00" });
    expect(w.map((x) => x.code)).toContain("W_TVA_GRID_59_INCORRECT_VALUE");
    // TEST = 2.900 is under 3.000 and under 100.000 -> no warning.
    expect(
      checkVatProbabilityRules({ "81": "10000.00", "59": "5000.00" }).map(
        (x) => x.code,
      ),
    ).not.toContain("W_TVA_GRID_59_INCORRECT_VALUE");
  });

  test("every warning carries the code Intervat expects and the rule that fired", () => {
    for (const w of checkVatProbabilityRules({
      "86": "1000.00",
      "87": "1000.00",
    })) {
      expect(w.code).toMatch(/^W_/);
      expect(w.rule.length).toBeGreaterThan(0);
      expect(w.message.length).toBeGreaterThan(0);
    }
  });
});

describe("tax parameters (C1)", () => {
  test("seeds unverified, and a missing parameter throws rather than defaulting", async () => {
    const { inserted } = await seedTaxParameters(db);
    expect(inserted).toBeGreaterThan(0);

    const threshold = await getTaxParameter(
      db,
      2026,
      "reduced_rate_min_remuneration",
    );
    expect(threshold.value).toBe(45000);
    // Seeded from the KB, never checked against the authority: must read as stale.
    expect(threshold.verifiedOn).toBeNull();
    expect(threshold.stale).toBe(true);
    expect(threshold.sourceUrl).toContain("financien.belgium.be");

    await expectError(
      getTaxParameter(db, 2026, "does_not_exist"),
      /missing for 2026/,
    );
  });

  test("seeding twice does not duplicate or overwrite", async () => {
    await db.query(
      `UPDATE tax_parameters SET verified_on = '2026-08-01', verified_by = 'jonas'
        WHERE year = 2026 AND key = 'reduced_rate_min_remuneration'`,
    );
    const second = await seedTaxParameters(db);
    expect(second.inserted).toBe(0);
    const after = await getTaxParameter(
      db,
      2026,
      "reduced_rate_min_remuneration",
    );
    expect(after.verifiedOn).toBe("2026-08-01"); // human verification survives re-seeding
    expect(after.stale).toBe(false);
    expect((await listTaxParameters(db, 2026)).length).toBeGreaterThanOrEqual(
      4,
    );
  });
});
