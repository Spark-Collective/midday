-- 0013_accounting_posting.sql
-- Accounting M1: posting hooks on existing documents + the first report view.
--   - invoices: document type (S7 credit notes), CN back-reference, posted-entry pointer
--   - transaction_categories: category -> PCMN account mapping (bank posting rule)
--   - journals: the journal's own GL side (bank/cash account)
--   - v_trial_balance: per-account totals over posted entries (RLS via security_invoker)

CREATE TYPE "invoice_type" AS ENUM ('invoice', 'credit_note');
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "invoice_type" "invoice_type" DEFAULT 'invoice' NOT NULL;
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "credited_invoice_id" uuid REFERENCES "invoices"("id");
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "journal_entry_id" uuid REFERENCES "journal_entries"("id");
--> statement-breakpoint
ALTER TABLE "transaction_categories" ADD COLUMN "gl_account_id" uuid REFERENCES "gl_accounts"("id");
--> statement-breakpoint
ALTER TABLE "journals" ADD COLUMN "gl_account_id" uuid REFERENCES "gl_accounts"("id");
--> statement-breakpoint

-- Trial balance over POSTED entries only. security_invoker so the caller's RLS
-- applies (Postgres 15+).
CREATE VIEW "v_trial_balance" WITH (security_invoker = true) AS
SELECT
  ll.team_id,
  a.id AS account_id,
  a.code,
  a.name,
  a.type,
  SUM(ll.debit) AS debit,
  SUM(ll.credit) AS credit,
  SUM(ll.debit - ll.credit) AS balance
FROM ledger_lines ll
JOIN journal_entries je ON je.id = ll.entry_id AND je.status = 'posted'
JOIN gl_accounts a ON a.id = ll.account_id
GROUP BY ll.team_id, a.id, a.code, a.name, a.type;
