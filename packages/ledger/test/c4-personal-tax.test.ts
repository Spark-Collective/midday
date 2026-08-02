/**
 * C4 (assembly half): the personal-tax pack collects every figure from the ledger
 * and the director's personal items, maps it to the right box, and reports gaps
 * instead of guessing. The tax computation itself is deliberately not here yet.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Pool, type PoolClient } from "pg";
import { linkDirectorAccounts } from "../src/owner.js";
import {
  buildPersonalTaxPack,
  comparePackToOfficial,
} from "../src/personal-tax.js";
import { postEntry } from "../src/post.js";
import { seedBelgianLedger } from "../src/seed.js";
import { expectError, initTestDb, TEST_DB_URL } from "./helpers/setup.js";

const pool = new Pool({ connectionString: TEST_DB_URL });
let db: PoolClient;
let teamId: string;
let directorId: string;

const ACCOUNTS: Array<[string, string, string]> = [
  ["618000", "Bezoldiging bedrijfsleider", "expense"],
  ["618010", "Voordeel personenwagen", "expense"],
  ["746410", "Voordeel personenwagen (recup)", "income"],
  ["453000", "Ingehouden voorheffingen", "liability"],
  ["618021", "Betaalde sociale lasten", "expense"],
  ["483000", "R/C bedrijfsleider", "liability"],
  ["550001", "Bank", "asset"],
];

beforeAll(async () => {
  db = await pool.connect();
  teamId = await initTestDb(db);
  await db.query("BEGIN");
  await seedBelgianLedger(db, { teamId, years: [2025] });
  await db.query("COMMIT");
  for (const [code, name, type] of ACCOUNTS) {
    await db.query(
      `INSERT INTO gl_accounts (team_id, code, name, type) VALUES ($1,$2,$3,$4)
       ON CONFLICT (team_id, code) DO NOTHING`,
      [teamId, code, name, type],
    );
  }
  await linkDirectorAccounts(db, teamId);
  const rc = await db.query(
    `SELECT id FROM gl_accounts WHERE team_id = $1 AND code = '483000'`,
    [teamId],
  );
  const d = await db.query(
    `INSERT INTO directors (team_id, name, gl_account_id) VALUES ($1,'Jonas',$2) RETURNING id`,
    [teamId, rc.rows[0].id],
  );
  directorId = d.rows[0].id;

  // A year of pay: 12 x 2.000 gross, 500/month withheld.
  for (let m = 1; m <= 12; m++) {
    await postEntry(db, {
      teamId,
      journalCode: "800",
      date: `2025-${String(m).padStart(2, "0")}-28`,
      lines: [
        { accountCode: "618000", debit: 2000 },
        { accountCode: "453000", credit: 500 },
        { accountCode: "483000", credit: 1500 },
      ],
    });
  }
  // Car benefit 1.800 charged, 600 recovered from the director.
  await postEntry(db, {
    teamId,
    journalCode: "800",
    date: "2025-12-31",
    lines: [
      { accountCode: "618010", debit: 1800 },
      { accountCode: "746410", credit: 600 },
      { accountCode: "483000", credit: 1200 },
    ],
  });
  // Social contributions paid by the company.
  await postEntry(db, {
    teamId,
    journalCode: "800",
    date: "2025-12-31",
    lines: [
      { accountCode: "618021", debit: 4200 },
      { accountCode: "550001", credit: 4200 },
    ],
  });
  // Personal-side items.
  for (const [kind, amount] of [
    ["vapz_premium", 3200],
    ["personal_advance_payment", 1500],
  ] as const) {
    await db.query(
      `INSERT INTO director_items (team_id, director_id, year, kind, amount)
       VALUES ($1,$2,2025,$3,$4)`,
      [teamId, directorId, kind, amount],
    );
  }
});

afterAll(async () => {
  db?.release();
  await pool.end();
});

describe("personal tax pack — assembly (C4)", () => {
  test("income year and assessment year are distinguished", async () => {
    const pack = await buildPersonalTaxPack(db, {
      teamId,
      directorId,
      incomeYear: 2025,
    });
    expect(pack.incomeYear).toBe(2025);
    expect(pack.assessmentYear).toBe(2026); // aanslagjaar = income year + 1
  });

  test("remuneration and benefits land in vak XVI, benefits net of recovery", async () => {
    const pack = await buildPersonalTaxPack(db, {
      teamId,
      directorId,
      incomeYear: 2025,
    });
    const rem = pack.lines.find((l) => l.boxKey === "remuneration");
    const vaa = pack.lines.find((l) => l.boxKey === "benefitsInKind");
    expect(rem?.amount).toBe(24000);
    expect(rem?.vak).toBe("XVI");
    expect(vaa?.amount).toBe(1200); // 1.800 - 600 recovered
    expect(pack.totals.grossProfessionalIncome).toBe(25200);
  });

  test("withholding is read from the credit side of 453000", async () => {
    const pack = await buildPersonalTaxPack(db, {
      teamId,
      directorId,
      incomeYear: 2025,
    });
    expect(pack.totals.withholding).toBe(6000);
    expect(pack.lines.find((l) => l.boxKey === "withholding")?.source).toBe(
      "ledger",
    );
  });

  test("personal items are picked up and attributed to their source", async () => {
    const pack = await buildPersonalTaxPack(db, {
      teamId,
      directorId,
      incomeYear: 2025,
    });
    // 4.200 company-paid social contributions + 3.200 VAPZ
    expect(pack.totals.deductibleContributions).toBe(7400);
    const advance = pack.lines.find((l) => l.boxKey === "advancePayments");
    expect(advance?.amount).toBe(1500);
    expect(advance?.source).toBe("director_item");
  });

  test("the company's own prepayments never leak into the personal return", async () => {
    // A corporate advance payment exists in the ledger but is not the director's.
    await db.query(
      `INSERT INTO gl_accounts (team_id, code, name, type, system_key)
       VALUES ($1,'670010','Voorafbetaling','expense','advance_tax_payment')
       ON CONFLICT (team_id, code) DO NOTHING`,
      [teamId],
    );
    await postEntry(db, {
      teamId,
      journalCode: "800",
      date: "2025-04-10",
      lines: [
        { accountCode: "670010", debit: 9999 },
        { accountCode: "550001", credit: 9999 },
      ],
    });
    const pack = await buildPersonalTaxPack(db, {
      teamId,
      directorId,
      incomeYear: 2025,
    });
    // Still only the 1.500 the director paid personally.
    expect(pack.totals.advancePayments).toBe(1500);
  });

  test("every line carries a source and a basis", async () => {
    const pack = await buildPersonalTaxPack(db, {
      teamId,
      directorId,
      incomeYear: 2025,
    });
    expect(pack.lines.length).toBeGreaterThan(0);
    for (const l of pack.lines) {
      expect(["ledger", "director_item", "official_fiche"]).toContain(l.source);
      expect(l.basis.length).toBeGreaterThan(0);
      expect(l.code).toMatch(/^\d{4}$/);
    }
  });

  test("gaps are reported, and always include the fiche cross-check", async () => {
    const pack = await buildPersonalTaxPack(db, {
      teamId,
      directorId,
      incomeYear: 2025,
    });
    expect(pack.gaps.join(" ")).toContain("281.20");

    // A year with nothing posted must say so rather than return a confident zero.
    const empty = await buildPersonalTaxPack(db, {
      teamId,
      directorId,
      incomeYear: 2024,
    });
    expect(empty.lines.length).toBe(0);
    expect(empty.gaps.join(" ")).toContain("No director remuneration posted");
  });

  test("an unknown director is rejected", async () => {
    await expectError(
      buildPersonalTaxPack(db, {
        teamId,
        directorId: "00000000-0000-0000-0000-000000000000",
        incomeYear: 2025,
      }),
      /not found/,
    );
  });
});

describe("cross-check against the official fiche (C4)", () => {
  test("agreement produces no differences", async () => {
    const pack = await buildPersonalTaxPack(db, {
      teamId,
      directorId,
      incomeYear: 2025,
    });
    expect(
      comparePackToOfficial(pack, {
        grossRemuneration: 24000,
        benefitsInKind: 1200,
        withholding: 6000,
      }),
    ).toEqual([]);
  });

  test("a disagreement is surfaced, not reconciled away", async () => {
    const pack = await buildPersonalTaxPack(db, {
      teamId,
      directorId,
      incomeYear: 2025,
    });
    const diffs = comparePackToOfficial(pack, {
      grossRemuneration: 24500, // the fiche says more than our books
      withholding: 6000,
    });
    expect(diffs.length).toBe(1);
    expect(diffs[0]?.field).toBe("grossRemuneration");
    expect(diffs[0]?.ours).toBe(24000);
    expect(diffs[0]?.theirs).toBe(24500);
    expect(diffs[0]?.difference).toBe(-500);
  });
});
