/**
 * Cash forecast (C6). The arithmetic is easy; what these guard are the four ways
 * a cash forecast silently lies: money counted twice, a filing whose amount is
 * invented, a payment date taken from the invoice rather than the customer's
 * habits, and an overdue receipt quietly dropped off the front of the curve.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Pool, type PoolClient } from "pg";
import {
  buildCashForecast,
  getPaymentLagDays,
  snapshotCashForecast,
} from "../src/cashflow.js";
import { seedBelgianLedger } from "../src/seed.js";
import { initTestDb, TEST_DB_URL } from "./helpers/setup.js";

const pool = new Pool({ connectionString: TEST_DB_URL });
let db: PoolClient;
let teamId: string;
let slowCustomer: string;
const ASOF = "2026-08-03";

async function account(name: string, balance: number, currency = "EUR") {
  await db.query(
    `INSERT INTO bank_accounts (team_id, name, currency, balance, enabled)
     VALUES ($1,$2,$3,$4,true)`,
    [teamId, name, currency, balance],
  );
}

async function invoice(opts: {
  customerId?: string | null;
  amount: number;
  due: string;
  status?: string;
  paidAt?: string | null;
  number?: string;
}) {
  const r = await db.query(
    `INSERT INTO invoices (team_id, customer_id, invoice_number, amount, currency,
                           issue_date, due_date, paid_at, status)
     VALUES ($1,$2,$3,$4,'EUR',$5,$5,$6,$7) RETURNING id`,
    [
      teamId,
      opts.customerId ?? null,
      opts.number ?? null,
      opts.amount,
      opts.due,
      opts.paidAt ?? null,
      opts.status ?? "unpaid",
    ],
  );
  return r.rows[0].id as string;
}

/** A posted cash payment against the account carrying `systemKey`. */
async function seedPayment(
  client: PoolClient,
  team: string,
  systemKey: string,
  date: string,
  amount: number,
) {
  await client.query(
    `INSERT INTO gl_accounts (team_id, code, name, type, system_key)
     VALUES ($1, $2, $3, 'expense', $4)
     ON CONFLICT ON CONSTRAINT gl_accounts_team_code_unique DO NOTHING`,
    [team, `T${systemKey.slice(0, 5)}`, systemKey, systemKey],
  );
  const period = await client.query(
    `SELECT id FROM fiscal_periods
      WHERE team_id = $1 AND year = EXTRACT(YEAR FROM $2::date)
        AND month = EXTRACT(MONTH FROM $2::date)`,
    [team, date],
  );
  const journal = await client.query(
    `SELECT id FROM journals WHERE team_id = $1 LIMIT 1`,
    [team],
  );
  // Entries are created draft and posted afterwards: a trigger enforces it.
  const entry = await client.query(
    `INSERT INTO journal_entries (team_id, journal_id, date, period_id)
     VALUES ($1,$2,$3::date,$4) RETURNING id`,
    [team, journal.rows[0].id, date, period.rows[0].id],
  );
  const id = entry.rows[0].id;
  for (const [key, debit, credit] of [
    [systemKey, amount, 0],
    ["internal_transfers", 0, amount],
  ] as Array<[string, number, number]>) {
    await client.query(
      `INSERT INTO ledger_lines (team_id, entry_id, account_id, debit, credit, currency, amount_currency)
       SELECT $1, $2, id, $3, $4, 'EUR', $5
         FROM gl_accounts WHERE team_id = $1 AND system_key = $6`,
      [team, id, debit, credit, debit > 0 ? debit : -credit, key],
    );
  }
  await client.query(
    `UPDATE journal_entries SET status = 'posted', posted_at = now() WHERE id = $1`,
    [id],
  );
}

beforeAll(async () => {
  db = await pool.connect();
  teamId = await initTestDb(db);
  await db.query("BEGIN");
  await seedBelgianLedger(db, { teamId, years: [2026] });
  await db.query("COMMIT");

  await account("KBC", 3000);
  await account("Revolut", 500);
  await account("Wise USD", 9999, "USD");

  const c = await db.query(
    `INSERT INTO customers (team_id, name) VALUES ($1,'Slow Payer') RETURNING id`,
    [teamId],
  );
  slowCustomer = c.rows[0].id;

  // Payment history: this customer is reliably 20 days late (3 samples, enough
  // to be believed).
  await invoice({
    customerId: slowCustomer,
    amount: 1000,
    due: "2026-01-31",
    paidAt: "2026-02-20",
    status: "paid",
  });
  await invoice({
    customerId: slowCustomer,
    amount: 1000,
    due: "2026-02-28",
    paidAt: "2026-03-20",
    status: "paid",
  });
  await invoice({
    customerId: slowCustomer,
    amount: 1000,
    due: "2026-03-31",
    paidAt: "2026-04-20",
    status: "paid",
  });
});

afterAll(async () => {
  db?.release();
  await pool.end();
});

describe("payment lag", () => {
  test("learns per customer, and needs enough samples to believe it", async () => {
    const { byCustomer, teamDefault } = await getPaymentLagDays(db, teamId);
    expect(byCustomer.get(slowCustomer)).toBe(20);
    expect(teamDefault).toBe(20);
  });
});

describe("opening balance", () => {
  test("sums enabled accounts in the base currency and flags the others", async () => {
    const f = await buildCashForecast(db, {
      teamId,
      asOf: ASOF,
      weeks: 2,
      months: 0,
    });
    expect(f.openingBalance).toBe(3500);
    expect(f.warnings.join(" ")).toContain("USD");
  });
});

describe("inflows", () => {
  test("an unpaid invoice lands on the due date PLUS how late that customer pays", async () => {
    const id = await invoice({
      customerId: slowCustomer,
      amount: 2000,
      due: "2026-08-10",
      number: "INV-1",
    });
    const f = await buildCashForecast(db, {
      teamId,
      asOf: ASOF,
      weeks: 8,
      months: 0,
    });
    const line = f.buckets
      .flatMap((b) => b.lines)
      .find((l) => l.sourceId === id);
    // Due the 10th, paid 20 days late: 30 August, not August the 10th.
    expect(line?.date).toBe("2026-08-30");
    expect(line?.amount).toBe(2000);
    expect(line?.estimated).toBe(true);

    await db.query("DELETE FROM invoices WHERE id = $1", [id]);
  });

  test("landed work invoices on its expected date, then waits payment terms", async () => {
    const p = await db.query(
      `INSERT INTO tracker_projects
         (team_id, name, customer_id, currency, contract_value, expected_invoice_date)
       VALUES ($1,'Bees energy',$2,'EUR',5000,'2026-09-01') RETURNING id`,
      [teamId, slowCustomer],
    );
    const f = await buildCashForecast(db, {
      teamId,
      asOf: ASOF,
      weeks: 13,
      months: 6,
    });
    const line = f.buckets
      .flatMap((b) => b.lines)
      .find((l) => l.sourceId === p.rows[0].id);
    // Invoiced 1 Sep, 30-day terms, 20 days late = 21 October.
    expect(line?.date).toBe("2026-10-21");
    expect(line?.amount).toBe(5000);
    expect(line?.kind).toBe("project");

    await db.query("DELETE FROM tracker_projects WHERE id = $1", [
      p.rows[0].id,
    ]);
  });

  test("an hourly project falls back to estimate x rate", async () => {
    const p = await db.query(
      `INSERT INTO tracker_projects
         (team_id, name, currency, rate, estimate, expected_invoice_date)
       VALUES ($1,'Hourly work','EUR',95,40,'2026-09-01') RETURNING id`,
      [teamId],
    );
    const f = await buildCashForecast(db, {
      teamId,
      asOf: ASOF,
      weeks: 13,
      months: 6,
    });
    const line = f.buckets
      .flatMap((b) => b.lines)
      .find((l) => l.sourceId === p.rows[0].id);
    expect(line?.amount).toBe(3800);

    await db.query("DELETE FROM tracker_projects WHERE id = $1", [
      p.rows[0].id,
    ]);
  });

  test("work already invoiced is NOT counted a second time", async () => {
    const p = await db.query(
      `INSERT INTO tracker_projects
         (team_id, name, customer_id, currency, contract_value, expected_invoice_date)
       VALUES ($1,'Half billed',$2,'EUR',10000,'2026-09-01') RETURNING id`,
      [teamId, slowCustomer],
    );
    const inv = await invoice({
      customerId: slowCustomer,
      amount: 6000,
      due: "2026-08-20",
      number: "INV-HALF",
    });
    await db.query("UPDATE invoices SET project_id = $1 WHERE id = $2", [
      p.rows[0].id,
      inv,
    ]);
    const f = await buildCashForecast(db, {
      teamId,
      asOf: ASOF,
      weeks: 13,
      months: 6,
    });
    const all = f.buckets.flatMap((b) => b.lines);
    const projectLine = all.find((l) => l.sourceId === p.rows[0].id);
    const invoiceLine = all.find((l) => l.sourceId === inv);

    // 10.000 of work, 6.000 already invoiced: the project may only add 4.000.
    expect(projectLine?.amount).toBe(4000);
    expect(invoiceLine?.amount).toBe(6000);
    const inflow = all
      .filter((l) => l.amount > 0)
      .reduce((s, l) => s + l.amount, 0);
    expect(inflow).toBe(10000);

    await db.query("DELETE FROM tracker_projects WHERE id = $1", [
      p.rows[0].id,
    ]);
    await db.query("DELETE FROM invoices WHERE id = $1", [inv]);
  });

  test("an unlinked invoice to the same customer warns about a possible double count", async () => {
    const p = await db.query(
      `INSERT INTO tracker_projects
         (team_id, name, customer_id, currency, contract_value, expected_invoice_date)
       VALUES ($1,'Unlinked risk',$2,'EUR',4000,'2026-09-01') RETURNING id`,
      [teamId, slowCustomer],
    );
    const inv = await invoice({
      customerId: slowCustomer,
      amount: 1500,
      due: "2026-08-25",
      number: "INV-LOOSE",
    });
    const f = await buildCashForecast(db, {
      teamId,
      asOf: ASOF,
      weeks: 13,
      months: 6,
    });
    expect(f.warnings.join(" ")).toContain("Unlinked risk");
    expect(f.warnings.join(" ")).toContain("double counted");
    // It still contributes in full: warned, not silently reduced by a guess.
    const line = f.buckets
      .flatMap((b) => b.lines)
      .find((l) => l.sourceId === p.rows[0].id);
    expect(line?.amount).toBe(4000);

    await db.query("DELETE FROM tracker_projects WHERE id = $1", [
      p.rows[0].id,
    ]);
    await db.query("DELETE FROM invoices WHERE id = $1", [inv]);
  });

  test("a project with a date but no value warns instead of contributing zero", async () => {
    const p = await db.query(
      `INSERT INTO tracker_projects (team_id, name, currency, expected_invoice_date)
       VALUES ($1,'Vague project','EUR','2026-09-01') RETURNING id`,
      [teamId],
    );
    const f = await buildCashForecast(db, {
      teamId,
      asOf: ASOF,
      weeks: 13,
      months: 6,
    });
    expect(f.warnings.join(" ")).toContain("Vague project");
    expect(f.warnings.join(" ")).toContain("no value");

    await db.query("DELETE FROM tracker_projects WHERE id = $1", [
      p.rows[0].id,
    ]);
  });
});

describe("outflows", () => {
  test("an unfiled obligation is an outflow on its due date; a filed one is not", async () => {
    await db.query(
      `INSERT INTO filings (team_id, kind, period_year, period_key, due_date, data)
       VALUES ($1,'vat_return',2026,'2026Q3','2026-10-25','{"grids":{"71":"4100.00"}}'::jsonb),
              ($1,'vat_return',2026,'2026Q2','2026-07-25','{"grids":{"71":"3000.00"}}'::jsonb)`,
      [teamId],
    );
    await db.query(
      `UPDATE filings SET status='filed', external_ref='x' WHERE period_key='2026Q2' AND team_id=$1`,
      [teamId],
    );

    const f = await buildCashForecast(db, {
      teamId,
      asOf: ASOF,
      weeks: 13,
      months: 6,
    });
    const filings = f.buckets
      .flatMap((b) => b.lines)
      .filter((l) => l.kind === "filing");
    expect(filings.length).toBe(1);
    expect(filings[0]?.amount).toBe(-4100);
    expect(filings[0]?.date).toBe("2026-10-25");
    // A prepared figure is a fact, not a guess.
    expect(filings[0]?.estimated).toBe(false);
  });

  test("a prepared VAT REFUND is an inflow, not an outflow", async () => {
    await db.query(
      `INSERT INTO filings (team_id, kind, period_year, period_key, due_date, data)
       VALUES ($1,'vat_return',2026,'2026M09','2026-10-20','{"grids":{"72":"800.00"}}'::jsonb)`,
      [teamId],
    );
    const f = await buildCashForecast(db, {
      teamId,
      asOf: ASOF,
      weeks: 13,
      months: 6,
    });
    const refund = f.buckets
      .flatMap((b) => b.lines)
      .find((l) => l.label.includes("2026M09"));
    expect(refund?.amount).toBe(800);
    await db.query(
      "DELETE FROM filings WHERE period_key = '2026M09' AND team_id = $1",
      [teamId],
    );
  });

  test("an unprepared obligation is estimated from what it has actually cost", async () => {
    await seedPayment(
      db,
      teamId,
      "social_contributions_paid",
      "2026-04-26",
      2595.06,
    );
    await seedPayment(
      db,
      teamId,
      "social_contributions_paid",
      "2026-07-12",
      1280.04,
    );
    await db.query(
      `INSERT INTO filings (team_id, kind, period_year, period_key, due_date)
       VALUES ($1,'social_contribution',2026,'2026Q4','2026-12-31')`,
      [teamId],
    );
    const f = await buildCashForecast(db, {
      teamId,
      asOf: ASOF,
      weeks: 13,
      months: 6,
    });
    const q4 = f.buckets
      .flatMap((b) => b.lines)
      .find((l) => l.label.includes("social contribution 2026Q4"));
    expect(q4?.amount).toBeCloseTo(-1937.55, 2);
    expect(q4?.estimated).toBe(true);
  });

  test("an obligation with no amount and no history is NOT silently omitted", async () => {
    await db.query(
      `INSERT INTO filings (team_id, kind, period_year, period_key, due_date)
       VALUES ($1,'corporate_tax',2026,'2026','2026-11-30')`,
      [teamId],
    );
    const f = await buildCashForecast(db, {
      teamId,
      asOf: ASOF,
      weeks: 13,
      months: 6,
    });
    expect(
      f.buckets
        .flatMap((b) => b.lines)
        .some((l) => l.label.includes("corporate tax")),
    ).toBe(false);
    expect(f.warnings.join(" ")).toContain("corporate tax 2026");
    expect(f.warnings.join(" ")).toContain("reads better than reality");
    await db.query(
      "DELETE FROM filings WHERE kind = 'corporate_tax' AND team_id = $1",
      [teamId],
    );
  });

  test("running costs come from actual spend, excluding what the filings already cover", async () => {
    await db.query(
      `INSERT INTO transactions (team_id, date, name, amount, currency)
       VALUES ($1,'2026-07-15','Hosting',-300,'EUR'),
              ($1,'2026-06-15','Hosting',-300,'EUR'),
              ($1,'2026-05-15','Hosting',-300,'EUR'),
              ($1,'2026-07-01','Client payment',5000,'EUR')`,
      [teamId],
    );
    const f = await buildCashForecast(db, {
      teamId,
      asOf: ASOF,
      weeks: 4,
      months: 0,
    });
    const runRate = f.buckets[0]?.lines.find((l) => l.kind === "run_rate");
    // 900 over 90 days = 300/month; a week is 300 * 7 / 30.44.
    expect(runRate?.amount).toBeCloseTo(-69, 0);
    // Inflows must never be mistaken for spend.
    expect(runRate?.amount).toBeLessThan(0);
  });
});

describe("the curve", () => {
  test("overdue money lands in the first bucket rather than falling off the front", async () => {
    const id = await invoice({
      amount: 750,
      due: "2026-06-01",
      status: "overdue",
      number: "INV-OLD",
    });
    const f = await buildCashForecast(db, {
      teamId,
      asOf: ASOF,
      weeks: 4,
      months: 0,
    });
    expect(f.buckets[0]?.lines.some((l) => l.sourceId === id)).toBe(true);
    await db.query("DELETE FROM invoices WHERE id = $1", [id]);
  });

  test("balances roll forward and the lowest point is reported", async () => {
    const f = await buildCashForecast(db, {
      teamId,
      asOf: ASOF,
      weeks: 13,
      months: 6,
    });
    let running = f.openingBalance;
    for (const b of f.buckets) {
      running = Math.round((running + b.inflow + b.outflow) * 100) / 100;
      expect(b.closing).toBeCloseTo(running, 2);
    }
    expect(f.lowest).not.toBeNull();
    const worst = Math.min(...f.buckets.map((b) => b.closing));
    expect(f.lowest?.balance).toBeCloseTo(worst, 2);
  });
});

describe("snapshots", () => {
  test("storing today's curve twice replaces it rather than accumulating", async () => {
    await snapshotCashForecast(db, { teamId, asOf: ASOF });
    await snapshotCashForecast(db, { teamId, asOf: ASOF });
    const r = await db.query(
      "SELECT count(*)::int n, opening_balance::float8 ob FROM cash_forecast_snapshots WHERE team_id=$1 GROUP BY 2",
      [teamId],
    );
    expect(r.rows[0].n).toBe(1);
    expect(r.rows[0].ob).toBe(3500);
  });
});
