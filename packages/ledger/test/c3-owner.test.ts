/**
 * C3 acceptance: the Owner surface reads the director's position out of the
 * existing ledger — pay against plan, benefits net of what was recovered, the
 * threshold meter, and the current-account direction (a debit R/C must warn).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Pool, type PoolClient } from "pg";
import {
  getOwnerSummary,
  linkDirectorAccounts,
  listDirectors,
} from "../src/owner.js";
import { postEntry } from "../src/post.js";
import { seedBelgianLedger } from "../src/seed.js";
import { seedTaxParameters } from "../src/tax-params.js";
import { expectError, initTestDb, TEST_DB_URL } from "./helpers/setup.js";

const pool = new Pool({ connectionString: TEST_DB_URL });
let db: PoolClient;
let teamId: string;
let directorId: string;

// A minimal Belgian director set-up, using the real PCMN codes.
const ACCOUNTS: Array<[string, string, string]> = [
  ["618000", "Bezoldiging bedrijfsleider", "expense"],
  ["618010", "Voordeel personenwagen", "expense"],
  ["618040", "Voordeel telefoon / gsm", "expense"],
  ["746410", "Voordeel personenwagen (recup)", "income"],
  ["453000", "Ingehouden voorheffingen", "liability"],
  ["618021", "Betaalde sociale lasten", "expense"],
  ["670010", "Voorafbetaling", "expense"],
  ["483000", "R/C bedrijfsleider", "liability"],
  ["550001", "Bank", "asset"],
];

beforeAll(async () => {
  db = await pool.connect();
  teamId = await initTestDb(db);
  await db.query("BEGIN");
  await seedBelgianLedger(db, { teamId, years: [2026] });
  await db.query("COMMIT");
  await seedTaxParameters(db);

  for (const [code, name, type] of ACCOUNTS) {
    await db.query(
      `INSERT INTO gl_accounts (team_id, code, name, type) VALUES ($1,$2,$3,$4)
       ON CONFLICT (team_id, code) DO NOTHING`,
      [teamId, code, name, type],
    );
  }
  const rc = await db.query(
    `SELECT id FROM gl_accounts WHERE team_id = $1 AND code = '483000'`,
    [teamId],
  );
  const d = await db.query(
    `INSERT INTO directors (team_id, name, status, gl_account_id, remuneration_monthly)
     VALUES ($1, 'Jonas', 'hoofdberoep', $2, 3750) RETURNING id`,
    [teamId, rc.rows[0].id],
  );
  directorId = d.rows[0].id;
});

afterAll(async () => {
  db?.release();
  await pool.end();
});

describe("account linking (C3)", () => {
  test("links the standard accounts and reports what is missing", async () => {
    const res = await linkDirectorAccounts(db, teamId);
    expect(res.linked.some((l) => l.startsWith("618000="))).toBe(true);
    expect(res.linked.some((l) => l.startsWith("483000="))).toBe(false); // R/C is per director, not a systemKey
    // 618070 (PC) and 615900 were never created here, so they must be reported.
    expect(res.missing.join(" ")).toContain("618070");
    expect(res.missing.join(" ")).toContain("615900");
  });

  test("is idempotent", async () => {
    const a = await linkDirectorAccounts(db, teamId);
    const b = await linkDirectorAccounts(db, teamId);
    expect(b.linked).toEqual(a.linked);
  });
});

describe("owner summary (C3)", () => {
  beforeAll(async () => {
    // Three months of pay: gross 3.750, withholding 1.000, net to the R/C.
    for (const month of ["01", "02", "03"]) {
      await postEntry(db, {
        teamId,
        journalCode: "800",
        date: `2026-${month}-28`,
        narration: `Remuneration ${month}`,
        lines: [
          { accountCode: "618000", debit: 3750 },
          { accountCode: "453000", credit: 1000 },
          { accountCode: "483000", credit: 2750 },
        ],
      });
    }
    // Benefit in kind: 1.680 car charged, 480 recovered from the director.
    await postEntry(db, {
      teamId,
      journalCode: "800",
      date: "2026-03-31",
      narration: "VAA car 2026",
      lines: [
        { accountCode: "618010", debit: 1680 },
        { accountCode: "746410", credit: 480 },
        { accountCode: "483000", credit: 1200 },
      ],
    });
    // Social contributions and an advance tax payment, both paid from the bank.
    await postEntry(db, {
      teamId,
      journalCode: "800",
      date: "2026-03-31",
      lines: [
        { accountCode: "618021", debit: 1243 },
        { accountCode: "550001", credit: 1243 },
      ],
    });
    await postEntry(db, {
      teamId,
      journalCode: "800",
      date: "2026-04-10",
      lines: [
        { accountCode: "670010", debit: 2000 },
        { accountCode: "550001", credit: 2000 },
      ],
    });
  });

  test("remuneration is measured against the plan", async () => {
    const s = await getOwnerSummary(db, { teamId, directorId, year: 2026 });
    expect(s.remuneration.postedYtd).toBe(11250); // 3 x 3.750
    expect(s.remuneration.monthsPosted).toBe(3);
    expect(s.director.remunerationMonthly).toBe(3750);
    // A past year counts all 12 months of plan; the current year counts elapsed ones.
    expect(s.remuneration.plannedYtd).toBeGreaterThanOrEqual(11250);
  });

  test("benefits are net of what the director repaid", async () => {
    const s = await getOwnerSummary(db, { teamId, directorId, year: 2026 });
    const car = s.benefits.find((b) => b.key === "vaa_car");
    expect(car?.amount).toBe(1200); // 1.680 charged - 480 recovered
    expect(s.benefitsTotal).toBe(1200);
  });

  test("withholding, social contributions and advances are picked up", async () => {
    const s = await getOwnerSummary(db, { teamId, directorId, year: 2026 });
    expect(s.withholdingYtd).toBe(3000);
    expect(s.socialContributionsYtd).toBe(1243);
    expect(s.advancePaymentsYtd).toBe(2000);
  });

  test("the threshold meter counts pay plus benefits, and carries provenance", async () => {
    const s = await getOwnerSummary(db, { teamId, directorId, year: 2026 });
    expect(s.threshold).not.toBeNull();
    expect(s.threshold!.remunerationCounted).toBe(12450); // 11.250 + 1.200
    expect(s.threshold!.value).toBe(45000);
    expect(Math.round(s.threshold!.pct)).toBe(28);
    // Seeded from the KB, never verified against the authority.
    expect(s.threshold!.parameter.stale).toBe(true);
    expect(s.threshold!.parameter.sourceUrl).toContain("financien.belgium.be");
  });

  test("a credit R/C means the company owes the director, and does not warn", async () => {
    const s = await getOwnerSummary(db, { teamId, directorId, year: 2026 });
    expect(s.currentAccount.accountCode).toBe("483000");
    expect(s.currentAccount.direction).toBe("credit");
    expect(s.currentAccount.balance).toBeCloseTo(9450, 2); // 3x2750 + 1200
    expect(s.currentAccount.warning).toBeNull();
  });

  test("a debit R/C warns about the deemed interest benefit", async () => {
    // The director draws more than the company owes them.
    await postEntry(db, {
      teamId,
      journalCode: "800",
      date: "2026-04-15",
      narration: "Director draw",
      lines: [
        { accountCode: "483000", debit: 12000 },
        { accountCode: "550001", credit: 12000 },
      ],
    });
    const s = await getOwnerSummary(db, { teamId, directorId, year: 2026 });
    expect(s.currentAccount.direction).toBe("debit");
    expect(s.currentAccount.balance).toBeLessThan(0);
    expect(s.currentAccount.warning).toContain("benefit in kind");
  });

  test("missing chart accounts are reported, not silently zero", async () => {
    const s = await getOwnerSummary(db, { teamId, directorId, year: 2026 });
    expect(s.unmappedAccounts.join(" ")).toContain("618070");
  });

  test("an unknown director is rejected", async () => {
    await expectError(
      getOwnerSummary(db, {
        teamId,
        directorId: "00000000-0000-0000-0000-000000000000",
        year: 2026,
      }),
      /not found/,
    );
  });

  test("listDirectors returns the team's directors", async () => {
    const rows = await listDirectors(db, teamId);
    expect(rows.length).toBe(1);
    expect(rows[0]?.name).toBe("Jonas");
    expect(rows[0]?.glAccountCode).toBe("483000");
    expect(rows[0]?.remunerationMonthly).toBe(3750);
  });
});
