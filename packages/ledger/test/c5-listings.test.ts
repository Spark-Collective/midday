/**
 * Client listing (lc) and IC statement (ico): the two Intervat listings that
 * report PER CUSTOMER. Both XML shapes were validated against the official XSDs
 * during the 2026-07 ACC round, so these tests guard the selection logic and the
 * things that are easy to get silently wrong (missing VAT numbers, Belgian vs
 * intra-EU split, threshold).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Pool, type PoolClient } from "pg";
import {
  buildClientListing,
  buildClientListingXml,
  buildIcStatement,
  buildIcStatementXml,
  type ListingDeclarant,
} from "../src/listings.js";
import { initTestDb, TEST_DB_URL } from "./helpers/setup.js";

const pool = new Pool({ connectionString: TEST_DB_URL });
let db: PoolClient;
let teamId: string;

const DECLARANT: ListingDeclarant = {
  vatNumber: "0805193139",
  name: "Spark Collective",
  street: "Teststraat 1",
  postCode: "9000",
  city: "Gent",
  email: "test@example.be",
};

async function customer(
  name: string,
  vat: string | null,
  country: string | null,
) {
  const r = await db.query(
    `INSERT INTO customers (team_id, name, vat_number, country) VALUES ($1,$2,$3,$4) RETURNING id`,
    [teamId, name, vat, country],
  );
  return r.rows[0].id as string;
}
async function invoice(
  customerId: string,
  date: string,
  amount: number,
  vat: number,
) {
  await db.query(
    `INSERT INTO invoices (team_id, customer_id, amount, vat, currency, issue_date, status)
     VALUES ($1,$2,$3,$4,'EUR',$5,'paid')`,
    [teamId, customerId, amount, vat, date],
  );
}

beforeAll(async () => {
  db = await pool.connect();
  teamId = await initTestDb(db);
  await db.query(
    `ALTER TABLE customers ADD COLUMN IF NOT EXISTS vat_number text,
       ADD COLUMN IF NOT EXISTS country text`,
  );
  await db.query(
    `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS customer_id uuid`,
  );

  const big = await customer("Big BE Client", "BE 0123.456.749", "BE");
  const small = await customer("Small BE Client", "0987654321", "BE");
  const noVat = await customer("Belgian No VAT", null, "BE");
  const dutch = await customer("Dutch Client", "NL123456782B01", "NL");
  const french = await customer("French Client", "FR12345678901", "FR");
  const offshore = await customer("Offshore Client", "MH999999", "MH");

  // 2025: two BE invoices (one large, one under threshold), plus intra-EU.
  await invoice(big, "2025-03-10", 12100, 2100); // 10.000 excl.
  await invoice(small, "2025-05-10", 121, 21); // 100 excl -> under threshold
  await invoice(noVat, "2025-06-10", 6050, 1050); // 5.000 excl, no VAT number
  await invoice(dutch, "2025-02-10", 5000, 0); // Q1 intra-EU
  await invoice(french, "2025-05-10", 3000, 0); // Q2 intra-EU
  await invoice(offshore, "2025-02-10", 9000, 0); // Q1, NOT EU
});

afterAll(async () => {
  db?.release();
  await pool.end();
});

describe("client listing (lc)", () => {
  test("includes Belgian customers above the threshold only", async () => {
    const r = await buildClientListing(db, {
      teamId,
      year: 2025,
      threshold: 250,
    });
    const names = r.rows.map((x) => x.customerName);
    expect(names).toContain("Big BE Client");
    // 100 excl. VAT is under the 250 threshold.
    expect(names).not.toContain("Small BE Client");
    // Intra-EU customers belong on the IC statement, not here.
    expect(names).not.toContain("Dutch Client");
  });

  test("turnover excludes VAT and the sums add up", async () => {
    const r = await buildClientListing(db, {
      teamId,
      year: 2025,
      threshold: 250,
    });
    const big = r.rows.find((x) => x.customerName === "Big BE Client");
    expect(big?.turnover).toBe(10000);
    expect(big?.vatAmount).toBe(2100);
    expect(r.turnoverSum).toBe(r.rows.reduce((s, x) => s + x.turnover, 0));
  });

  test("a Belgian VAT number is normalised to 10 digits", async () => {
    const r = await buildClientListing(db, {
      teamId,
      year: 2025,
      threshold: 250,
    });
    expect(
      r.rows.find((x) => x.customerName === "Big BE Client")?.vatNumber,
    ).toBe("0123456749");
  });

  test("a customer without a usable VAT number WARNS instead of vanishing", async () => {
    const r = await buildClientListing(db, {
      teamId,
      year: 2025,
      threshold: 250,
    });
    expect(r.rows.some((x) => x.customerName === "Belgian No VAT")).toBe(false);
    expect(r.warnings.join(" ")).toContain("Belgian No VAT");
    expect(r.warnings.join(" ")).toContain("missing from the listing");
  });

  test("an empty year still warns rather than silently producing nothing", async () => {
    const r = await buildClientListing(db, {
      teamId,
      year: 2019,
      threshold: 250,
    });
    expect(r.rows.length).toBe(0);
    expect(r.warnings.join(" ")).toContain("nil listing");
  });

  test("XML carries the declarant, totals and one Client per row", async () => {
    const listing = await buildClientListing(db, {
      teamId,
      year: 2025,
      threshold: 250,
    });
    const xml = buildClientListingXml({ declarant: DECLARANT, listing });
    expect(xml).toContain("ClientListingConsignment");
    expect(xml).toContain('ClientsNbr="1"');
    expect(xml).toContain('TurnOverSum="10000.00"');
    expect(xml).toContain('<ns2:CompanyVATNumber issuedBy="BE">0123456749<');
    expect(xml).toContain("<ns2:Period>2025</ns2:Period>");
    expect(xml).not.toContain("ReplacedClientListing");
  });

  test("a corrective listing carries the replaced reference", async () => {
    const listing = await buildClientListing(db, {
      teamId,
      year: 2025,
      threshold: 250,
    });
    const xml = buildClientListingXml({
      declarant: DECLARANT,
      listing,
      replaces: "1-0805193139-202500",
    });
    expect(xml).toContain(
      "<ns2:ReplacedClientListing>1-0805193139-202500</ns2:ReplacedClientListing>",
    );
  });
});

describe("IC statement (ico)", () => {
  test("selects only intra-EU customers, by period", async () => {
    const q1 = await buildIcStatement(db, { teamId, year: 2025, quarter: 1 });
    expect(q1.rows.map((r) => r.customerName)).toEqual(["Dutch Client"]);
    expect(q1.amountSum).toBe(5000);

    const q2 = await buildIcStatement(db, { teamId, year: 2025, quarter: 2 });
    expect(q2.rows.map((r) => r.customerName)).toEqual(["French Client"]);
    // The Belgian invoice in the same quarter must not appear here.
    expect(q2.rows.some((r) => r.countryCode === "BE")).toBe(false);
  });

  test("a non-EU customer is excluded and explained, not filed as intra-EU", async () => {
    const q1 = await buildIcStatement(db, { teamId, year: 2025, quarter: 1 });
    expect(q1.rows.some((r) => r.countryCode === "MH")).toBe(false);
    expect(q1.warnings.join(" ")).toContain("Offshore Client");
    expect(q1.warnings.join(" ")).toContain("outside the EU");
    // ...and its 9.000 must not inflate the total.
    expect(q1.amountSum).toBe(5000);
  });

  test("the country prefix is split off the VAT number", async () => {
    const q1 = await buildIcStatement(db, { teamId, year: 2025, quarter: 1 });
    expect(q1.rows[0]?.countryCode).toBe("NL");
    expect(q1.rows[0]?.vatNumber).toBe("123456782B01");
  });

  test("defaults to services AND says so, because it cannot be derived", async () => {
    const q1 = await buildIcStatement(db, { teamId, year: 2025, quarter: 1 });
    expect(q1.rows[0]?.code).toBe("S");
    expect(q1.warnings.join(" ")).toContain("default to code S");
    const goods = await buildIcStatement(db, {
      teamId,
      year: 2025,
      quarter: 1,
      defaultCode: "L",
    });
    expect(goods.rows[0]?.code).toBe("L");
  });

  test("XML carries the period and one IntraClient per row", async () => {
    const statement = await buildIcStatement(db, {
      teamId,
      year: 2025,
      quarter: 1,
    });
    const xml = buildIcStatementXml({ declarant: DECLARANT, statement });
    expect(xml).toContain("IntraConsignment");
    expect(xml).toContain('AmountSum="5000.00"');
    expect(xml).toContain("<ns2:Quarter>1</ns2:Quarter>");
    expect(xml).toContain("<ns2:Year>2025</ns2:Year>");
    expect(xml).toContain('issuedBy="NL"');
    expect(xml).toContain("<ns2:Code>S</ns2:Code>");
  });

  test("a month period renders Month, not Quarter", async () => {
    const statement = await buildIcStatement(db, {
      teamId,
      year: 2025,
      month: 2,
    });
    const xml = buildIcStatementXml({ declarant: DECLARANT, statement });
    expect(xml).toContain("<ns2:Month>2</ns2:Month>");
    expect(xml).not.toContain("<ns2:Quarter>");
  });
});
