/**
 * Shared real-Postgres test setup: drops and recreates everything the
 * accounting migrations touch (including minimal stubs of the Midday document
 * tables that 0013 alters), then applies 0012 + 0013. exchange_rates is stubbed
 * at numeric(10,2) on purpose so the F1 widening in 0012 is genuinely exercised.
 */

import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PoolClient } from "pg";

export const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5433/midday_test";

const M12 = readFileSync(
  join(import.meta.dir, "../../../db/migrations/0012_accounting_core.sql"),
  "utf8",
);
const M13 = readFileSync(
  join(import.meta.dir, "../../../db/migrations/0013_accounting_posting.sql"),
  "utf8",
);
const M14 = readFileSync(
  join(
    import.meta.dir,
    "../../../db/migrations/0014_accounting_amortization.sql",
  ),
  "utf8",
);
const M15 = readFileSync(
  join(
    import.meta.dir,
    "../../../db/migrations/0015_accounting_report_views.sql",
  ),
  "utf8",
);
const M16 = readFileSync(
  join(
    import.meta.dir,
    "../../../db/migrations/0016_accounting_reversed_in_reports.sql",
  ),
  "utf8",
);

const M39 = readFileSync(
  join(import.meta.dir, "../../../db/migrations/0039_compliance_workflows.sql"),
  "utf8",
);

const M40 = readFileSync(
  join(import.meta.dir, "../../../db/migrations/0040_expense_notes.sql"),
  "utf8",
);

const M41 = readFileSync(
  join(import.meta.dir, "../../../db/migrations/0041_asset_acquisition_value.sql"),
  "utf8",
);

const M48 = readFileSync(
  join(
    import.meta.dir,
    "../../../db/migrations/0048_drop_project_forecast_fields.sql",
  ),
  "utf8",
);

const M49 = readFileSync(
  join(import.meta.dir, "../../../db/migrations/0049_purchase_documents.sql"),
  "utf8",
);

const M50 = readFileSync(
  join(
    import.meta.dir,
    "../../../db/migrations/0050_inbox_billing_reference.sql",
  ),
  "utf8",
);

const M47 = readFileSync(
  join(
    import.meta.dir,
    "../../../db/migrations/0047_proposal_status_withdrawn.sql",
  ),
  "utf8",
);

const M46 = readFileSync(
  join(import.meta.dir, "../../../db/migrations/0046_proposal_vat.sql"),
  "utf8",
);

const M45 = readFileSync(
  join(import.meta.dir, "../../../db/migrations/0045_proposals.sql"),
  "utf8",
);

const M43 = readFileSync(
  join(import.meta.dir, "../../../db/migrations/0043_cash_forecast.sql"),
  "utf8",
);

const M44 = readFileSync(
  join(import.meta.dir, "../../../db/migrations/0044_budgets.sql"),
  "utf8",
);

const BOOTSTRAP = `
  DROP VIEW IF EXISTS v_trial_balance;
  DROP VIEW IF EXISTS v_general_ledger;
  DROP VIEW IF EXISTS v_open_items;
  DROP VIEW IF EXISTS v_verworpen_uitgaven;
  DROP TABLE IF EXISTS purchase_document_lines, purchase_documents, inbox,
    expense_note_lines, expense_notes,
    budgets, cash_forecast_snapshots, proposals, tracker_projects,
    customers, filings, director_items, directors, tax_parameters,
    amortization_lines, amortizations,
    reconciliation_allocations, reconciliations, vu_rates,
    tax_codes, ledger_lines, journal_entries, fiscal_periods, journals,
    gl_accounts, invoices, transactions, transaction_categories, bank_accounts CASCADE;
  DROP TYPE IF EXISTS proposal_status, filing_kind, filing_status, gl_account_type, journal_type, fiscal_period_status,
    journal_entry_status, journal_entry_source, ledger_party_type, tax_kind,
    invoice_type, amortization_kind CASCADE;
  CREATE SCHEMA IF NOT EXISTS private;
  CREATE OR REPLACE FUNCTION private.get_teams_for_authenticated_user()
    RETURNS SETOF uuid LANGUAGE sql
    AS $$ SELECT '00000000-0000-0000-0000-000000000000'::uuid LIMIT 0 $$;
  CREATE TABLE IF NOT EXISTS users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid()
  );
  CREATE TABLE IF NOT EXISTS teams (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), base_currency text
  );
  DROP TABLE IF EXISTS exchange_rates;
  CREATE TABLE exchange_rates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    base text, rate numeric(10,2), target text, updated_at timestamptz
  );
  CREATE TABLE invoices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id uuid NOT NULL, customer_id uuid, customer_name text,
    invoice_number text, amount numeric(10,2), vat numeric(10,2), currency text,
    issue_date timestamptz, status text DEFAULT 'unpaid',
    due_date timestamptz, paid_at timestamptz
  );
  CREATE TABLE transactions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id uuid NOT NULL, date date NOT NULL, name text NOT NULL,
    amount numeric(10,2) NOT NULL, currency text NOT NULL, bank_account_id uuid,
    category_slug text, base_amount numeric(10,2), base_currency text,
    tax_amount numeric(10,2), status text DEFAULT 'posted'
  );
  CREATE TABLE transaction_categories (
    id uuid DEFAULT gen_random_uuid() UNIQUE NOT NULL,
    team_id uuid NOT NULL, slug text, name text, excluded boolean DEFAULT false
  );
  CREATE TABLE customers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id uuid NOT NULL, name text NOT NULL,
    vat_number text, country text
  );
  CREATE TABLE bank_accounts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id uuid NOT NULL, name text, currency text,
    balance numeric(14,2) DEFAULT 0, enabled boolean DEFAULT true
  );
  CREATE TABLE proposals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    token text UNIQUE NOT NULL DEFAULT gen_random_uuid()::text,
    deal_id uuid, organization_id uuid, client_name text,
    title text NOT NULL, summary text,
    content jsonb NOT NULL DEFAULT '[]'::jsonb, ai_context jsonb,
    currency text NOT NULL DEFAULT 'EUR',
    -- The funnel's own CHECK, mirrored so a status it rejects fails HERE too.
    -- 'withdrawn' is absent on purpose: migration 0047 is what adds it.
    status text NOT NULL DEFAULT 'draft'
      CHECK (status IN ('draft','sent','viewed','accepted','declined','expired')),
    expires_at date,
    first_viewed_at timestamptz, last_viewed_at timestamptz,
    view_count integer NOT NULL DEFAULT 0, owner text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE tracker_projects (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id uuid NOT NULL, name text NOT NULL, customer_id uuid,
    rate numeric(10,2), currency text, estimate bigint,
    billable boolean DEFAULT false, status text DEFAULT 'in_progress'
  );
  -- Minimal inbox stub: migration 0049 references it (FK + enum alter).
  DO $do$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'inbox_type') THEN
      CREATE TYPE inbox_type AS ENUM ('invoice', 'expense', 'other');
    END IF;
  END $do$;
  CREATE TABLE inbox (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id uuid NOT NULL, display_name text, amount numeric(10,2),
    currency text, type inbox_type, status text DEFAULT 'pending'
  );
`;

/** Fresh accounting schema on the connection; returns a new team id. */
export async function initTestDb(db: PoolClient): Promise<string> {
  await db.query(BOOTSTRAP);
  await db.query(M12);
  await db.query(M13);
  await db.query(M14);
  await db.query(M15);
  await db.query(M16);
  await db.query(M39);
  await db.query(M40);
  await db.query(M41);
  await db.query(M43);
  await db.query(M44);
  await db.query(M45);
  await db.query(M46);
  await db.query(M47);
  await db.query(M48);
  await db.query(M49);
  await db.query(M50);
  const team = await db.query(
    `INSERT INTO teams (base_currency) VALUES ('EUR') RETURNING id`,
  );
  return team.rows[0].id;
}

export async function expectError(promise: Promise<unknown>, match: RegExp) {
  let message = "";
  try {
    await promise;
  } catch (err) {
    message = (err as Error).message;
  }
  expect(message).toMatch(match);
}
