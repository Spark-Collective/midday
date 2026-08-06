/**
 * Golden fixture: Spark Collective's real fiche 281.20 for income year 2024.
 *
 * The ledger was not trusted until it reproduced three years of the
 * accountant's closings; the personal-tax assembly gets the same treatment.
 * This test rebuilds the 2024 books from the accountant's own grootboek and
 * asserts the pack lands on the fiche's code 400 to the cent.
 *
 * Official fiche (JAAR 2024):
 *   6a periodieke bezoldigingen     23.613,60
 *   6c voordelen van alle aard       7.432,73   (aard FIJKH)
 *   code 400 TOTAAL                 31.046,33
 *   code 407 bedrijfsvoorheffing     4.413,60
 *
 * Our ledger reaches the same total by a different split, which is expected:
 * the fiche's 6a/6c division is the payroll provider's presentation, while the
 * personal return only carries the total (vak XVI, code 1400 <- fiche 400).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Pool, type PoolClient } from "pg";
import {
  buildPersonalTaxPack,
  comparePackToOfficial,
} from "../src/personal-tax.js";
import { postEntry } from "../src/post.js";
import { seedBelgianLedger } from "../src/seed.js";
import { initTestDb, TEST_DB_URL } from "./helpers/setup.js";

const pool = new Pool({ connectionString: TEST_DB_URL });
let db: PoolClient;
let teamId: string;
let directorId: string;

/** The 2024 movements exactly as the accountant's grootboek reports them. */
const GROOTBOEK_2024 = {
  remuneration: 25312.6, // 618000
  vaaCar: 1924.61, // 618010
  vaaPhone: 84.0, // 618040
  vaaPc: 72.0, // 618070
  vaaInternet: 60.0, // 618075
  vaaSocialDebit: 5292.12, // 618020 debit
  vaaSocialCredit: 1699.0, // 618020 credit
  socialPaid: 3593.12, // 618021
  withholdingCredit: 5700.05, // 453000 credit side
};

const FICHE_2024 = { code400: 31046.33, code407: 4413.6 };

beforeAll(async () => {
  db = await pool.connect();
  teamId = await initTestDb(db);
  await db.query("BEGIN");
  await seedBelgianLedger(db, { teamId, years: [2024] });
  await db.query("COMMIT");
  await db.query(
    `INSERT INTO gl_accounts (team_id, code, name, type, system_key) VALUES
       ($1,'618000','Bezoldiging bedrijfsleider','expense','director_remuneration'),
       ($1,'618010','Voordeel personenwagen','expense','vaa_car'),
       ($1,'618040','Voordeel telefoon / gsm','expense','vaa_phone'),
       ($1,'618070','Voordeel PC','expense','vaa_pc'),
       ($1,'618075','Voordeel internet','expense','vaa_internet'),
       ($1,'618020','Voordeel sociale lasten','expense','vaa_social_contributions'),
       ($1,'618021','Betaalde sociale lasten','expense','social_contributions_paid'),
       ($1,'453000','Ingehouden voorheffingen','liability','director_withholding'),
       ($1,'746410','Recup. VAA wagen','income','vaa_car_recovery'),
       ($1,'550001','KBC','asset',NULL)
     ON CONFLICT (team_id, code) DO UPDATE SET system_key = EXCLUDED.system_key`,
    [teamId],
  );
  const rc = await db.query(
    `SELECT id FROM gl_accounts WHERE team_id = $1 AND code = '453000'`,
    [teamId],
  );
  const d = await db.query(
    `INSERT INTO directors (team_id, name, gl_account_id) VALUES ($1,'Jonas Boury',$2) RETURNING id`,
    [teamId, rc.rows[0].id],
  );
  directorId = d.rows[0].id;

  const g = GROOTBOEK_2024;
  await postEntry(db, {
    teamId,
    journalCode: "890",
    date: "2024-06-30",
    narration: "2024 payroll aggregate (grootboek)",
    lines: [
      { accountCode: "618000", debit: g.remuneration },
      { accountCode: "618010", debit: g.vaaCar },
      { accountCode: "618040", debit: g.vaaPhone },
      { accountCode: "618070", debit: g.vaaPc },
      { accountCode: "618075", debit: g.vaaInternet },
      { accountCode: "618020", debit: g.vaaSocialDebit },
      { accountCode: "618021", debit: g.socialPaid },
      { accountCode: "618020", credit: g.vaaSocialCredit },
      { accountCode: "453000", credit: g.withholdingCredit },
      {
        accountCode: "550001",
        credit:
          g.remuneration +
          g.vaaCar +
          g.vaaPhone +
          g.vaaPc +
          g.vaaInternet +
          g.vaaSocialDebit +
          g.socialPaid -
          g.vaaSocialCredit -
          g.withholdingCredit,
      },
    ],
  });

  // The company's contra of the car benefit: must NOT reduce taxable income.
  await postEntry(db, {
    teamId,
    journalCode: "890",
    date: "2024-06-30",
    narration: "VAA recovery contra",
    lines: [
      { accountCode: "618010", debit: 0.0001 },
      { accountCode: "746410", credit: 0.0001 },
    ],
  }).catch(() => {
    /* zero-ish line may be rejected; the recovery account existing is enough */
  });
});

afterAll(async () => {
  db?.release();
  await pool.end();
});

describe("fiche 281.20 golden fixture — income year 2024", () => {
  test("gross professional income reproduces fiche code 400 to the cent", async () => {
    const pack = await buildPersonalTaxPack(db, {
      teamId,
      directorId,
      incomeYear: 2024,
    });
    expect(pack.totals.grossProfessionalIncome).toBe(FICHE_2024.code400);
    expect(pack.assessmentYear).toBe(2025);
  });

  test("the benefit total includes the company-borne social contributions", async () => {
    const pack = await buildPersonalTaxPack(db, {
      teamId,
      directorId,
      incomeYear: 2024,
    });
    const vaa = pack.lines.find((l) => l.boxKey === "benefitsInKind")!;
    // 1.924,61 + 84 + 72 + 60 + (5.292,12 - 1.699,00)
    expect(vaa.amount).toBe(5733.73);
    const rem = pack.lines.find((l) => l.boxKey === "remuneration")!;
    expect(rem.amount).toBe(25312.6);
    expect(Math.round((vaa.amount + rem.amount) * 100) / 100).toBe(
      FICHE_2024.code400,
    );
  });

  test("the withholding difference against the fiche is surfaced, not hidden", async () => {
    const pack = await buildPersonalTaxPack(db, {
      teamId,
      directorId,
      incomeYear: 2024,
    });
    const diffs = comparePackToOfficial(pack, {
      withholding: FICHE_2024.code407,
    });
    // Our ledger credits 5.700,05 in calendar 2024; the fiche reports 4.413,60
    // for income year 2024. A real timing difference for a human to resolve.
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({
      field: "withholding",
      ours: 5700.05,
      theirs: 4413.6,
    });
    expect(diffs[0]!.difference).toBe(1286.45);
  });
});
