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

const BOOTSTRAP = `
  DROP VIEW IF EXISTS v_trial_balance;
  DROP VIEW IF EXISTS v_verworpen_uitgaven;
  DROP TABLE IF EXISTS amortization_lines, amortizations,
    reconciliation_allocations, reconciliations, vu_rates,
    tax_codes, ledger_lines, journal_entries, fiscal_periods, journals,
    gl_accounts, invoices, transactions, transaction_categories, bank_accounts CASCADE;
  DROP TYPE IF EXISTS gl_account_type, journal_type, fiscal_period_status,
    journal_entry_status, journal_entry_source, ledger_party_type, tax_kind,
    invoice_type, amortization_kind CASCADE;
  CREATE SCHEMA IF NOT EXISTS private;
  CREATE OR REPLACE FUNCTION private.get_teams_for_authenticated_user()
    RETURNS SETOF uuid LANGUAGE sql
    AS $$ SELECT '00000000-0000-0000-0000-000000000000'::uuid LIMIT 0 $$;
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
    issue_date timestamptz, status text DEFAULT 'unpaid'
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
    team_id uuid NOT NULL, slug text, name text
  );
  CREATE TABLE bank_accounts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id uuid NOT NULL, name text, currency text
  );
`;

/** Fresh accounting schema on the connection; returns a new team id. */
export async function initTestDb(db: PoolClient): Promise<string> {
  await db.query(BOOTSTRAP);
  await db.query(M12);
  await db.query(M13);
  await db.query(M14);
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
