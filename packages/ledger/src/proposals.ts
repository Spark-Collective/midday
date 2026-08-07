/**
 * Proposals: the priced offer and the service-level agreement, as one document.
 *
 * A proposal is prose (scope, why, pricing, SLA, caveats, next steps) plus a
 * small commercial core. Only the core is read by the cash forecast; the prose is
 * for the human on the other side. Authored mostly by Claude Code through the MCP
 * tools rather than typed into a form, which is why the write surface takes a
 * whole document at once and validates hard.
 *
 * The lifecycle is the point: `accepted` is a dated fact, which is what the
 * forecast was missing. Everything before it is a hope and contributes nothing.
 *
 * Design: docs/architecture/midday-proposals-2026-08-03.md.
 */
import type { PoolClient } from "pg";
import { LedgerError } from "./post.js";

export type ProposalStatus =
  | "draft"
  | "sent"
  | "accepted"
  | "declined"
  | "expired"
  | "withdrawn";

export type RecurringInterval = "month" | "quarter" | "year";

export type ProposalInput = {
  teamId: string;
  id?: string;
  customerId?: string | null;
  projectId?: string | null;
  title: string;
  currency?: string;
  oneOffAmount?: number | null;
  recurringAmount?: number | null;
  recurringInterval?: RecurringInterval | null;
  recurringMonths?: number | null;
  validUntil?: string | null;
  expectedInvoiceDate?: string | null;
  bodyMd?: string | null;
  /**
   * The rich document, in the same block format the Spark website proposals use
   * (prose | table | links | image). Preferred over bodyMd when present: it is
   * what makes a proposal read like the ones actually sent to clients.
   */
  content?: unknown[] | null;
  sla?: Record<string, unknown> | null;
  documentUrl?: string | null;
  /** Percent. 21 = Belgian standard; 0 for reverse charge or non-EU. */
  vatRate?: number | null;
};

/**
 * Only forward moves, and only from somewhere sensible. A proposal that has been
 * accepted and invoiced must not quietly become a draft again: the forecast, and
 * any invoice raised against it, depend on that acceptance standing.
 */
const ALLOWED_TRANSITIONS: Record<ProposalStatus, ProposalStatus[]> = {
  draft: ["sent", "withdrawn"],
  sent: ["accepted", "declined", "expired", "withdrawn"],
  accepted: ["withdrawn"],
  declined: [],
  expired: ["sent"],
  withdrawn: [],
};

const LIFECYCLE = new Set<string>([
  "draft",
  "sent",
  "accepted",
  "declined",
  "expired",
  "withdrawn",
]);

/**
 * `status` is TEXT, not an enum, because the website funnel writes this table too
 * and has its own vocabulary.
 *
 * `viewed` is the one that matters: the funnel sets it when the client OPENS the
 * share link, so it means sent-and-read. Folding it into the generic unknown
 * bucket would make a live offer look like an unsent draft and hide the accept
 * action. Anything genuinely unrecognised degrades to `draft`, which is the safe
 * direction: never crash, and never silently count as revenue.
 */
function asStatus(value: string): ProposalStatus {
  if (value === "viewed") return "sent";
  return LIFECYCLE.has(value) ? (value as ProposalStatus) : "draft";
}

/** P-2026-001, per team, per year. Never the invoice sequence. */
export async function nextProposalNumber(
  client: PoolClient,
  teamId: string,
  year: number,
): Promise<string> {
  const r = await client.query(
    `SELECT number FROM proposals
      WHERE team_id = $1 AND number LIKE $2
      ORDER BY number DESC LIMIT 1`,
    [teamId, `P-${year}-%`],
  );
  const last = r.rows[0]?.number as string | undefined;
  const n = last ? Number(last.split("-")[2]) + 1 : 1;
  return `P-${year}-${String(n).padStart(3, "0")}`;
}

export async function upsertProposal(
  client: PoolClient,
  input: ProposalInput,
): Promise<{ id: string; number: string; token?: string }> {
  if (!input.title?.trim()) throw new LedgerError("a proposal needs a title");

  const recurringAmount = input.recurringAmount ?? null;
  const recurringInterval = input.recurringInterval ?? null;
  if ((recurringAmount === null) !== (recurringInterval === null)) {
    throw new LedgerError(
      "recurring pricing needs BOTH an amount and an interval (month, quarter or year)",
    );
  }
  if (
    (input.oneOffAmount ?? null) === null &&
    recurringAmount === null &&
    !input.id
  ) {
    throw new LedgerError(
      "a proposal needs a one-off amount, a recurring amount, or both: an offer with no price cannot be forecast or accepted",
    );
  }

  if (input.id) {
    const current = await client.query(
      "SELECT status FROM proposals WHERE id = $1 AND team_id = $2",
      [input.id, input.teamId],
    );
    if (current.rowCount === 0) throw new LedgerError("proposal not found");
    // Editing the terms of an offer already out in the world would silently
    // disagree with the copy the client is reading.
    if (current.rows[0].status !== "draft") {
      throw new LedgerError(
        `proposal is ${current.rows[0].status}, not draft: withdraw it and write a new one rather than editing terms the client has already seen`,
      );
    }
    const r = await client.query(
      `UPDATE proposals SET
         customer_id = $1, project_id = $2, title = $3, currency = COALESCE($4, currency),
         one_off_amount = $5, recurring_amount = $6, recurring_interval = $7,
         recurring_months = $8, expires_at = $9, expected_invoice_date = $10,
         body_md = COALESCE($11, body_md), sla = COALESCE($12::jsonb, sla),
         document_url = COALESCE($13, document_url),
         vat_rate = COALESCE($16, vat_rate),
         content = COALESCE($17::jsonb, content), updated_at = now()
       WHERE id = $14 AND team_id = $15
       RETURNING id, number`,
      [
        input.customerId ?? null,
        input.projectId ?? null,
        input.title.trim(),
        input.currency ?? null,
        input.oneOffAmount ?? null,
        recurringAmount,
        recurringInterval,
        input.recurringMonths ?? null,
        input.validUntil ?? null,
        input.expectedInvoiceDate ?? null,
        input.bodyMd ?? null,
        input.sla ? JSON.stringify(input.sla) : null,
        input.documentUrl ?? null,
        input.id,
        input.teamId,
        input.vatRate ?? null,
        input.content ? JSON.stringify(input.content) : null,
      ],
    );
    return r.rows[0];
  }

  const year = Number(
    (input.validUntil ?? new Date().toISOString()).slice(0, 4),
  );
  const number = await nextProposalNumber(client, input.teamId, year);
  const r = await client.query(
    `INSERT INTO proposals
       (team_id, customer_id, project_id, number, title, currency,
        one_off_amount, recurring_amount, recurring_interval, recurring_months,
        expires_at, expected_invoice_date, body_md, sla, document_url,
        client_name, vat_rate, content)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6,'EUR'),$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,
             COALESCE((SELECT name FROM customers WHERE id = $2), $5),
             COALESCE($16, 21), COALESCE($17::jsonb, '[]'::jsonb))
     RETURNING id, number, token`,
    [
      input.teamId,
      input.customerId ?? null,
      input.projectId ?? null,
      number,
      input.title.trim(),
      input.currency ?? null,
      input.oneOffAmount ?? null,
      recurringAmount,
      recurringInterval,
      input.recurringMonths ?? null,
      input.validUntil ?? null,
      input.expectedInvoiceDate ?? null,
      input.bodyMd ?? null,
      input.sla ? JSON.stringify(input.sla) : null,
      input.documentUrl ?? null,
      input.vatRate ?? null,
      input.content ? JSON.stringify(input.content) : null,
    ],
  );
  return r.rows[0];
}

/**
 * Move a proposal along its lifecycle.
 *
 * Accepting is the moment money becomes forecastable, so it demands the one
 * thing the forecast needs and cannot infer: WHEN the one-off gets billed.
 */
export async function setProposalStatus(
  client: PoolClient,
  input: {
    teamId: string;
    proposalId: string;
    status: ProposalStatus;
    /** Required when accepting a proposal that has a one-off amount. */
    expectedInvoiceDate?: string | null;
    decidedOn?: string | null;
  },
): Promise<{ status: ProposalStatus }> {
  const r = await client.query(
    `SELECT status, one_off_amount::float8 AS one_off, project_id,
            expected_invoice_date::text AS expected
       FROM proposals WHERE id = $1 AND team_id = $2`,
    [input.proposalId, input.teamId],
  );
  if (r.rowCount === 0) throw new LedgerError("proposal not found");
  const row = r.rows[0];
  const from = asStatus(row.status);

  if (from === input.status) return { status: from };
  if (!ALLOWED_TRANSITIONS[from].includes(input.status)) {
    throw new LedgerError(
      `cannot move a proposal from ${from} to ${input.status}`,
    );
  }

  const expected = input.expectedInvoiceDate ?? row.expected ?? null;
  if (input.status === "accepted" && row.one_off && !expected) {
    throw new LedgerError(
      "accepting an offer with a one-off amount needs an expected invoice date: acceptance date is not invoice date",
    );
  }

  await client.query(
    `UPDATE proposals
        SET status = $1,
            expected_invoice_date = COALESCE($2::date, expected_invoice_date),
            sent_at = CASE WHEN $1 = 'sent'
                           THEN COALESCE(sent_at, now()) ELSE sent_at END,
            decided_at = CASE WHEN $1 IN ('accepted','declined','expired','withdrawn')
                              THEN COALESCE($3::timestamptz, now()) ELSE decided_at END,
            updated_at = now()
      WHERE id = $4 AND team_id = $5`,
    [
      input.status,
      expected,
      input.decidedOn ?? null,
      input.proposalId,
      input.teamId,
    ],
  );

  return { status: input.status };
}

export type ProposalRow = {
  id: string;
  /** Share token: the key to the public proposal page. */
  token: string;
  number: string;
  title: string;
  status: ProposalStatus;
  customerId: string | null;
  customerName: string | null;
  projectId: string | null;
  currency: string;
  oneOffAmount: number | null;
  recurringAmount: number | null;
  recurringInterval: RecurringInterval | null;
  recurringMonths: number | null;
  validUntil: string | null;
  expectedInvoiceDate: string | null;
  documentUrl: string | null;
  vatRate: number;
  sentAt: string | null;
  decidedAt: string | null;
  invoiced: number;
  bodyMd?: string | null;
  content?: unknown[] | null;
  sla?: Record<string, unknown> | null;
};

export async function listProposals(
  client: PoolClient,
  input: {
    teamId: string;
    customerId?: string;
    status?: ProposalStatus[];
    includeBody?: boolean;
  },
): Promise<ProposalRow[]> {
  const r = await client.query(
    `SELECT p.id, p.token, p.number, p.title, p.status, p.customer_id, c.name AS customer_name,
            p.project_id, p.currency,
            p.one_off_amount::float8 AS one_off_amount,
            p.recurring_amount::float8 AS recurring_amount,
            p.recurring_interval, p.recurring_months,
            p.expires_at::text AS valid_until,
            p.vat_rate::float8 AS vat_rate,
            p.expected_invoice_date::text AS expected_invoice_date,
            p.document_url, p.sent_at, p.decided_at,
            ${input.includeBody ? "p.body_md, p.sla," : ""}
            COALESCE((
              SELECT sum(i.amount) FROM invoices i
               WHERE i.proposal_id = p.id AND i.status <> 'canceled'
            ), 0)::float8 AS invoiced
       FROM proposals p
       LEFT JOIN customers c ON c.id = p.customer_id
      WHERE p.team_id = $1
        AND ($2::uuid IS NULL OR p.customer_id = $2::uuid)
        AND ($3::text[] IS NULL OR p.status::text = ANY($3::text[]))
      ORDER BY p.created_at DESC`,
    [input.teamId, input.customerId ?? null, input.status ?? null],
  );

  return r.rows.map((x) => ({
    id: x.id,
    token: x.token,
    number: x.number,
    title: x.title,
    status: asStatus(x.status),
    customerId: x.customer_id,
    customerName: x.customer_name,
    projectId: x.project_id,
    currency: x.currency,
    oneOffAmount: x.one_off_amount,
    recurringAmount: x.recurring_amount,
    recurringInterval: x.recurring_interval,
    recurringMonths: x.recurring_months,
    validUntil: x.valid_until,
    expectedInvoiceDate: x.expected_invoice_date,
    documentUrl: x.document_url,
    vatRate: x.vat_rate,
    sentAt: x.sent_at,
    decidedAt: x.decided_at,
    invoiced: x.invoiced,
    ...(input.includeBody ? { bodyMd: x.body_md, sla: x.sla } : {}),
  }));
}

/**
 * Sweep offers past their validity date out of `sent`.
 *
 * An offer that lapsed three months ago sitting in your pipeline as "sent" is
 * how a win rate becomes a lie. Only `sent` lapses: a draft you never sent has
 * nothing to expire.
 */
export async function expireLapsedProposals(
  client: PoolClient,
  input: { teamId: string; asOf?: string },
): Promise<{ expired: number }> {
  const r = await client.query(
    `UPDATE proposals
        SET status = 'expired', decided_at = now(), updated_at = now()
      WHERE team_id = $1 AND status = 'sent'
        AND expires_at IS NOT NULL
        AND expires_at < COALESCE($2::date, CURRENT_DATE)`,
    [input.teamId, input.asOf ?? null],
  );
  return { expired: r.rowCount ?? 0 };
}

/**
 * What a CLIENT may see through the customer portal.
 *
 * An ALLOWLIST, on purpose. The same denylist habit that would have put quotes
 * into the VAT client listing would here leak an internal draft to the client
 * the moment a new status is added. Drafts and withdrawn offers are ours;
 * everything the client has actually been sent, they may read.
 *
 * `body_md` is returned, which makes it CLIENT-FACING BY DEFINITION. Internal
 * notes do not belong in it.
 */
const CLIENT_VISIBLE = ["sent", "viewed", "accepted", "declined", "expired"];

export async function listPortalProposals(
  client: PoolClient,
  input: { portalId: string },
): Promise<ProposalRow[]> {
  const r = await client.query(
    `SELECT p.id, p.token, p.number, p.title, p.status, p.customer_id, c.name AS customer_name,
            p.project_id, p.currency,
            p.one_off_amount::float8 AS one_off_amount,
            p.recurring_amount::float8 AS recurring_amount,
            p.recurring_interval, p.recurring_months,
            p.expires_at::text AS valid_until,
            p.vat_rate::float8 AS vat_rate,
            p.expected_invoice_date::text AS expected_invoice_date,
            p.document_url, p.sent_at, p.decided_at, p.body_md, p.sla,
            0::float8 AS invoiced
       FROM proposals p
       JOIN customers c ON c.id = p.customer_id
      WHERE c.portal_id = $1 AND c.portal_enabled = true
        AND p.team_id = c.team_id
        AND p.status = ANY($2::text[])
      ORDER BY p.created_at DESC`,
    [input.portalId, CLIENT_VISIBLE],
  );
  return r.rows.map((x) => ({
    id: x.id,
    token: x.token,
    number: x.number,
    title: x.title,
    status: asStatus(x.status),
    customerId: x.customer_id,
    customerName: x.customer_name,
    projectId: x.project_id,
    currency: x.currency,
    oneOffAmount: x.one_off_amount,
    recurringAmount: x.recurring_amount,
    recurringInterval: x.recurring_interval,
    recurringMonths: x.recurring_months,
    validUntil: x.valid_until,
    expectedInvoiceDate: x.expected_invoice_date,
    documentUrl: x.document_url,
    vatRate: x.vat_rate,
    sentAt: x.sent_at,
    decidedAt: x.decided_at,
    invoiced: x.invoiced,
    bodyMd: x.body_md,
    sla: x.sla,
  }));
}

/**
 * One proposal by its share token: the client-facing page.
 *
 * Same ALLOWLIST as the portal list. A token is unguessable, but "unguessable"
 * is not "authorised to see a draft": an offer the client has not been sent must
 * not be readable just because someone has the link, and a withdrawn one must
 * stop being readable the moment it is superseded.
 *
 * Also bumps the view counters the funnel already maintained, so "has the client
 * opened it" keeps working now that Midday serves the page too.
 */
export async function getProposalByToken(
  client: PoolClient,
  input: { token: string; countView?: boolean },
): Promise<ProposalRow | null> {
  const r = await client.query(
    `SELECT p.id, p.token, p.number, p.title, p.status, p.customer_id,
            COALESCE(c.name, p.client_name) AS customer_name,
            p.project_id, p.currency,
            p.one_off_amount::float8 AS one_off_amount,
            p.recurring_amount::float8 AS recurring_amount,
            p.recurring_interval, p.recurring_months,
            p.expires_at::text AS valid_until,
            p.vat_rate::float8 AS vat_rate,
            p.expected_invoice_date::text AS expected_invoice_date,
            p.document_url, p.sent_at, p.decided_at, p.body_md, p.sla,
            p.content,
            0::float8 AS invoiced
       FROM proposals p
       LEFT JOIN customers c ON c.id = p.customer_id
      WHERE p.token = $1 AND p.status = ANY($2::text[])`,
    [input.token, CLIENT_VISIBLE],
  );
  const x = r.rows[0];
  if (!x) return null;

  if (input.countView) {
    await client.query(
      `UPDATE proposals
          SET view_count = view_count + 1,
              first_viewed_at = COALESCE(first_viewed_at, now()),
              last_viewed_at = now()
        WHERE id = $1`,
      [x.id],
    );
  }

  return {
    id: x.id,
    token: x.token,
    number: x.number,
    title: x.title,
    status: asStatus(x.status),
    customerId: x.customer_id,
    customerName: x.customer_name,
    projectId: x.project_id,
    currency: x.currency,
    oneOffAmount: x.one_off_amount,
    recurringAmount: x.recurring_amount,
    recurringInterval: x.recurring_interval,
    recurringMonths: x.recurring_months,
    validUntil: x.valid_until,
    expectedInvoiceDate: x.expected_invoice_date,
    documentUrl: x.document_url,
    vatRate: x.vat_rate,
    sentAt: x.sent_at,
    decidedAt: x.decided_at,
    invoiced: x.invoiced,
    bodyMd: x.body_md,
    content: x.content,
    sla: x.sla,
  };
}
