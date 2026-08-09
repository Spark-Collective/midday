/**
 * What the customer portal exposes (C9).
 *
 * The portal is a PUBLIC page behind an unguessable id, so the only thing worth
 * testing here is the boundary: a client must see what was sent to them and
 * nothing else, and must never see another customer's offers.
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
import {
  getProposalByToken,
  listPortalProposals,
  upsertProposal,
} from "../src/proposals.js";
import { initTestDb, TEST_DB_URL } from "./helpers/setup.js";

const pool = new Pool({ connectionString: TEST_DB_URL });
let db: PoolClient;
let teamId: string;
let openCustomer: string;
let closedCustomer: string;

async function proposal(customerId: string, title: string, status: string) {
  const p = await upsertProposal(db, {
    teamId,
    customerId,
    title,
    oneOffAmount: 1000,
    validUntil: "2026-12-31",
    bodyMd: `# ${title}\n\nThe offer.`,
  });
  await db.query("UPDATE proposals SET status = $1 WHERE id = $2", [
    status,
    p.id,
  ]);
  return p.id;
}

beforeAll(async () => {
  db = await pool.connect();
  teamId = await initTestDb(db);
  await db.query(
    `ALTER TABLE customers ADD COLUMN IF NOT EXISTS portal_id text,
       ADD COLUMN IF NOT EXISTS portal_enabled boolean DEFAULT false`,
  );
  const a = await db.query(
    `INSERT INTO customers (team_id, name, portal_id, portal_enabled)
     VALUES ($1,'Portal Client','portal-aaa',true) RETURNING id`,
    [teamId],
  );
  openCustomer = a.rows[0].id;
  const b = await db.query(
    `INSERT INTO customers (team_id, name, portal_id, portal_enabled)
     VALUES ($1,'Other Client','portal-bbb',false) RETURNING id`,
    [teamId],
  );
  closedCustomer = b.rows[0].id;
});

afterEach(async () => {
  await db.query("DELETE FROM proposals WHERE team_id = $1", [teamId]);
});

afterAll(async () => {
  db?.release();
  await pool.end();
});

describe("customer portal visibility", () => {
  test("a draft is NEVER exposed, however the portal is reached", async () => {
    await proposal(openCustomer, "Internal draft", "draft");
    const rows = await listPortalProposals(db, { portalId: "portal-aaa" });
    expect(rows.length).toBe(0);
  });

  test("a withdrawn offer disappears from the client's view", async () => {
    await proposal(openCustomer, "Superseded", "withdrawn");
    expect(
      (await listPortalProposals(db, { portalId: "portal-aaa" })).length,
    ).toBe(0);
  });

  test("sent, accepted and declined offers are visible, with the document", async () => {
    await proposal(openCustomer, "Sent offer", "sent");
    await proposal(openCustomer, "Won offer", "accepted");
    await proposal(openCustomer, "Lost offer", "declined");
    const rows = await listPortalProposals(db, { portalId: "portal-aaa" });
    expect(rows.map((r) => r.title).sort()).toEqual([
      "Lost offer",
      "Sent offer",
      "Won offer",
    ]);
    // The list is deliberately light: the document ships on the /pr/[token]
    // page (getProposalByToken), not with every row.
    expect(rows[0]?.bodyMd).toBeUndefined();
  });

  test("'viewed' from the funnel is visible and reads as sent", async () => {
    await proposal(openCustomer, "Opened by client", "viewed");
    const rows = await listPortalProposals(db, { portalId: "portal-aaa" });
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe("sent");
  });

  test("a portal that is switched off shows nothing", async () => {
    await proposal(closedCustomer, "Should stay hidden", "accepted");
    expect(
      (await listPortalProposals(db, { portalId: "portal-bbb" })).length,
    ).toBe(0);
  });

  test("a client never sees another customer's offers", async () => {
    await proposal(openCustomer, "Mine", "accepted");
    await db.query("UPDATE customers SET portal_enabled = true WHERE id = $1", [
      closedCustomer,
    ]);
    await proposal(closedCustomer, "Not mine", "accepted");
    const rows = await listPortalProposals(db, { portalId: "portal-aaa" });
    expect(rows.map((r) => r.title)).toEqual(["Mine"]);
    await db.query(
      "UPDATE customers SET portal_enabled = false WHERE id = $1",
      [closedCustomer],
    );
  });

  test("a token opens the proposal, and counts the view", async () => {
    const id = await proposal(openCustomer, "By link", "sent");
    const token = (
      await db.query("SELECT token FROM proposals WHERE id = $1", [id])
    ).rows[0].token as string;

    const first = await getProposalByToken(db, { token, countView: true });
    expect(first?.title).toBe("By link");
    expect(first?.bodyMd).toContain("The offer.");

    const counted = await db.query(
      "SELECT view_count, first_viewed_at IS NOT NULL AS seen FROM proposals WHERE id = $1",
      [id],
    );
    expect(counted.rows[0].view_count).toBe(1);
    expect(counted.rows[0].seen).toBe(true);
  });

  test("a token does NOT open a draft or a withdrawn offer", async () => {
    for (const status of ["draft", "withdrawn"]) {
      const id = await proposal(openCustomer, `Hidden ${status}`, status);
      const token = (
        await db.query("SELECT token FROM proposals WHERE id = $1", [id])
      ).rows[0].token as string;
      expect(await getProposalByToken(db, { token })).toBeNull();
    }
  });

  test("an unknown token returns null rather than erroring", async () => {
    expect(await getProposalByToken(db, { token: "nope" })).toBeNull();
  });

  test("an unknown portal id returns nothing rather than erroring", async () => {
    expect((await listPortalProposals(db, { portalId: "nope" })).length).toBe(
      0,
    );
  });
});
