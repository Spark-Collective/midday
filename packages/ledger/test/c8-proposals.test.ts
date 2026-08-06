/**
 * Proposals (C8). Two things are worth guarding: the lifecycle, because a
 * proposal's status is the evidence the forecast rests on, and the boundary with
 * projects, because the same money described in two places is the failure that
 * makes a forecast worthless.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { Pool, type PoolClient } from "pg";
import { buildCashForecast } from "../src/cashflow.js";
import {
  expireLapsedProposals,
  listProposals,
  setProposalStatus,
  upsertProposal,
} from "../src/proposals.js";
import { expectError, initTestDb, TEST_DB_URL } from "./helpers/setup.js";

const pool = new Pool({ connectionString: TEST_DB_URL });
let db: PoolClient;
let teamId: string;
let customerId: string;
const ASOF = "2026-08-03";

beforeAll(async () => {
  db = await pool.connect();
  teamId = await initTestDb(db);
  const c = await db.query(
    `INSERT INTO customers (team_id, name) VALUES ($1,'Pulse Foundation') RETURNING id`,
    [teamId],
  );
  customerId = c.rows[0].id;
  await db.query(
    `INSERT INTO bank_accounts (team_id, name, currency, balance, enabled)
     VALUES ($1,'KBC','EUR',10000,true)`,
    [teamId],
  );
});

// Each test starts from no proposals: a failed assertion skips its own cleanup,
// and leftover accepted offers silently change the next test's forecast.
afterEach(async () => {
  await db.query("DELETE FROM invoices WHERE proposal_id IS NOT NULL");
  await db.query("DELETE FROM proposals WHERE team_id = $1", [teamId]);
});

afterAll(async () => {
  db?.release();
  await pool.end();
});

describe("writing a proposal", () => {
  test("numbers run per team per year and never touch the invoice sequence", async () => {
    const a = await upsertProposal(db, {
      teamId,
      customerId,
      title: "Agentic website and workspace",
      oneOffAmount: 5000,
      validUntil: "2026-09-30",
    });
    const b = await upsertProposal(db, {
      teamId,
      title: "Second offer",
      oneOffAmount: 1000,
      validUntil: "2026-09-30",
    });
    expect(a.number).toBe("P-2026-001");
    expect(b.number).toBe("P-2026-002");
    await db.query("DELETE FROM proposals WHERE id = $1", [b.id]);
  });

  test("an offer with no price is refused", async () => {
    await expectError(
      upsertProposal(db, { teamId, title: "Vague ideas" }),
      /needs a one-off amount, a recurring amount, or both/,
    );
  });

  test("recurring pricing needs both an amount and an interval", async () => {
    await expectError(
      upsertProposal(db, {
        teamId,
        title: "Half a retainer",
        recurringAmount: 500,
      }),
      /BOTH an amount and an interval/,
    );
  });

  test("the funnel's 'viewed' reads as SENT, not as an unsent draft", async () => {
    const p = await upsertProposal(db, {
      teamId,
      customerId,
      title: "Opened by the client",
      oneOffAmount: 1000,
      validUntil: "2026-12-31",
    });
    // What the website funnel does when the client opens the share link.
    await db.query("UPDATE proposals SET status = 'viewed' WHERE id = $1", [
      p.id,
    ]);
    const [row] = await listProposals(db, { teamId });
    expect(row?.status).toBe("sent");
    // ...so it can still be accepted, which a 'draft' reading would have blocked.
    await setProposalStatus(db, {
      teamId,
      proposalId: p.id,
      status: "accepted",
      expectedInvoiceDate: "2026-10-01",
    });
    expect((await listProposals(db, { teamId }))[0]?.status).toBe("accepted");
  });

  test("the document body and the SLA round-trip", async () => {
    const p = await upsertProposal(db, {
      teamId,
      customerId,
      title: "Support agreement",
      recurringAmount: 500,
      recurringInterval: "month",
      bodyMd: "## SLA\n\nI respond within one business day.",
      sla: { responseTime: "1 business day", noticePeriodDays: 30 },
    });
    const [row] = await listProposals(db, {
      teamId,
      status: ["draft"],
      includeBody: true,
    });
    expect(row?.bodyMd).toContain("one business day");
    expect((row?.sla as { noticePeriodDays: number })?.noticePeriodDays).toBe(
      30,
    );
    await db.query("DELETE FROM proposals WHERE id = $1", [p.id]);
  });
});

describe("the lifecycle", () => {
  test("terms cannot be edited once the client has seen them", async () => {
    const p = await upsertProposal(db, {
      teamId,
      title: "Sent already",
      oneOffAmount: 2000,
      validUntil: "2026-12-31",
    });
    await setProposalStatus(db, {
      teamId,
      proposalId: p.id,
      status: "sent",
    });
    await expectError(
      upsertProposal(db, {
        teamId,
        id: p.id,
        title: "Sneaky",
        oneOffAmount: 9000,
      }),
      /withdraw it and write a new one/,
    );
    await db.query("DELETE FROM proposals WHERE id = $1", [p.id]);
  });

  test("only sensible moves are allowed", async () => {
    const p = await upsertProposal(db, {
      teamId,
      title: "Transitions",
      oneOffAmount: 100,
      validUntil: "2026-12-31",
    });
    // draft cannot jump straight to accepted: it was never sent.
    await expectError(
      setProposalStatus(db, { teamId, proposalId: p.id, status: "accepted" }),
      /cannot move a proposal from draft to accepted/,
    );
    await setProposalStatus(db, { teamId, proposalId: p.id, status: "sent" });
    await setProposalStatus(db, {
      teamId,
      proposalId: p.id,
      status: "declined",
    });
    // A decision is final.
    await expectError(
      setProposalStatus(db, { teamId, proposalId: p.id, status: "accepted" }),
      /cannot move a proposal from declined to accepted/,
    );
    await db.query("DELETE FROM proposals WHERE id = $1", [p.id]);
  });

  test("accepting a priced offer demands an invoice date, because acceptance is not billing", async () => {
    const p = await upsertProposal(db, {
      teamId,
      customerId,
      title: "Needs a date",
      oneOffAmount: 3000,
      validUntil: "2026-12-31",
    });
    await setProposalStatus(db, { teamId, proposalId: p.id, status: "sent" });
    await expectError(
      setProposalStatus(db, { teamId, proposalId: p.id, status: "accepted" }),
      /needs an expected invoice date/,
    );
    await setProposalStatus(db, {
      teamId,
      proposalId: p.id,
      status: "accepted",
      expectedInvoiceDate: "2026-11-01",
    });
    const [row] = await listProposals(db, { teamId, status: ["accepted"] });
    expect(row?.expectedInvoiceDate).toBe("2026-11-01");
    expect(row?.decidedAt).toBeTruthy();
    await db.query("DELETE FROM proposals WHERE id = $1", [p.id]);
  });

  test("a lapsed offer expires, but a draft never sent does not", async () => {
    const sent = await upsertProposal(db, {
      teamId,
      title: "Lapsed",
      oneOffAmount: 500,
      validUntil: "2026-06-30",
    });
    const draft = await upsertProposal(db, {
      teamId,
      title: "Never sent",
      oneOffAmount: 500,
      validUntil: "2026-06-30",
    });
    await setProposalStatus(db, {
      teamId,
      proposalId: sent.id,
      status: "sent",
    });

    const res = await expireLapsedProposals(db, { teamId, asOf: ASOF });
    expect(res.expired).toBe(1);
    const rows = await listProposals(db, { teamId });
    expect(rows.find((r) => r.id === sent.id)?.status).toBe("expired");
    expect(rows.find((r) => r.id === draft.id)?.status).toBe("draft");

    await db.query("DELETE FROM proposals WHERE id = ANY($1)", [
      [sent.id, draft.id],
    ]);
  });
});

describe("what reaches the forecast", () => {
  async function accept(input: {
    title: string;
    oneOff?: number | null;
    recurring?: number | null;
    interval?: "month" | "quarter" | "year" | null;
    months?: number | null;
    date?: string;
    vatRate?: number;
  }) {
    const p = await upsertProposal(db, {
      teamId,
      customerId,
      title: input.title,
      oneOffAmount: input.oneOff ?? null,
      recurringAmount: input.recurring ?? null,
      recurringInterval: input.interval ?? null,
      recurringMonths: input.months ?? null,
      validUntil: "2026-12-31",
      vatRate: input.vatRate ?? 0,
    });
    await setProposalStatus(db, { teamId, proposalId: p.id, status: "sent" });
    await setProposalStatus(db, {
      teamId,
      proposalId: p.id,
      status: "accepted",
      expectedInvoiceDate: input.date ?? "2026-09-01",
    });
    return p.id;
  }

  test("a sent proposal is worth nothing; accepting it is what makes it money", async () => {
    const p = await upsertProposal(db, {
      teamId,
      customerId,
      title: "Still selling",
      oneOffAmount: 8000,
      expectedInvoiceDate: "2026-09-01",
      validUntil: "2026-12-31",
      vatRate: 0,
    });
    await setProposalStatus(db, { teamId, proposalId: p.id, status: "sent" });
    let f = await buildCashForecast(db, {
      teamId,
      asOf: ASOF,
      weeks: 13,
      months: 6,
    });
    expect(
      f.buckets.flatMap((b) => b.lines).some((l) => l.kind === "proposal"),
    ).toBe(false);

    await setProposalStatus(db, {
      teamId,
      proposalId: p.id,
      status: "accepted",
      expectedInvoiceDate: "2026-09-01",
    });
    f = await buildCashForecast(db, {
      teamId,
      asOf: ASOF,
      weeks: 13,
      months: 6,
    });
    const line = f.buckets
      .flatMap((b) => b.lines)
      .find((l) => l.sourceId === p.id);
    // Invoiced 1 Sep, 30-day terms, no payment history for this customer.
    expect(line?.date).toBe("2026-10-01");
    expect(line?.amount).toBe(8000);

    await db.query("DELETE FROM proposals WHERE id = $1", [p.id]);
  });

  test("a NET offer reaches the forecast GROSS, because that is what moves", async () => {
    const id = await accept({
      title: "Belgian client",
      oneOff: 10000,
      date: "2026-09-01",
      vatRate: 21,
    });
    const f = await buildCashForecast(db, {
      teamId,
      asOf: ASOF,
      weeks: 13,
      months: 6,
    });
    const line = f.buckets
      .flatMap((b) => b.lines)
      .find((l) => l.sourceId === id);
    // 10.000 quoted, 12.100 actually lands in the bank.
    expect(line?.amount).toBe(12100);
  });

  test("a retainer repeats over its committed term, not forever", async () => {
    const id = await accept({
      title: "Support SLA",
      recurring: 500,
      interval: "month",
      months: 3,
      date: "2026-09-01",
    });
    const f = await buildCashForecast(db, {
      teamId,
      asOf: ASOF,
      weeks: 13,
      months: 12,
    });
    const lines = f.buckets
      .flatMap((b) => b.lines)
      .filter((l) => l.sourceId === id);
    expect(lines.length).toBe(3);
    expect(lines.every((l) => l.amount === 500)).toBe(true);
    await db.query("DELETE FROM proposals WHERE id = $1", [id]);
  });

  test("a quarterly retainer bills every three months", async () => {
    const id = await accept({
      title: "Quarterly care",
      recurring: 900,
      interval: "quarter",
      months: 12,
      date: "2026-09-01",
    });
    const f = await buildCashForecast(db, {
      teamId,
      asOf: ASOF,
      weeks: 13,
      months: 12,
    });
    const dates = f.buckets
      .flatMap((b) => b.lines)
      .filter((l) => l.sourceId === id)
      .map((l) => l.date)
      .sort();
    expect(dates[0]).toBe("2026-10-01");
    expect(dates[1]).toBe("2026-12-31");
    await db.query("DELETE FROM proposals WHERE id = $1", [id]);
  });

  test("invoicing against a proposal nets it down rather than adding to it", async () => {
    const id = await accept({
      title: "Part billed",
      oneOff: 10000,
      date: "2026-09-01",
    });
    await db.query(
      `INSERT INTO invoices (team_id, customer_id, proposal_id, invoice_number,
                             amount, currency, issue_date, due_date, status)
       VALUES ($1,$2,$3,'INV-P',4000,'EUR','2026-08-20','2026-08-20','unpaid')`,
      [teamId, customerId, id],
    );
    const f = await buildCashForecast(db, {
      teamId,
      asOf: ASOF,
      weeks: 13,
      months: 6,
    });
    const all = f.buckets.flatMap((b) => b.lines).filter((l) => l.amount > 0);
    const proposalLine = all.find((l) => l.sourceId === id);
    expect(proposalLine?.amount).toBe(6000);
    // 4.000 invoiced + 6.000 still to bill = the 10.000 that was agreed, once.
    expect(all.reduce((s, l) => s + l.amount, 0)).toBe(10000);

    await db.query("DELETE FROM invoices WHERE proposal_id = $1", [id]);
    await db.query("DELETE FROM proposals WHERE id = $1", [id]);
  });
});
