-- 0015_accounting_report_views.sql
-- Accounting M4: the remaining read views (plan §6). RLS via security_invoker.

CREATE VIEW "v_general_ledger" WITH (security_invoker = true) AS
SELECT
  ll.team_id,
  je.date,
  je.entry_number,
  j.code AS journal_code,
  a.code AS account_code,
  a.name AS account_name,
  ll.debit,
  ll.credit,
  ll.currency,
  ll.amount_currency,
  COALESCE(ll.description, je.narration) AS description,
  ll.entry_id,
  ll.id AS line_id
FROM ledger_lines ll
JOIN journal_entries je ON je.id = ll.entry_id AND je.status = 'posted'
JOIN journals j ON j.id = je.journal_id
JOIN gl_accounts a ON a.id = ll.account_id;
--> statement-breakpoint

-- Open items: unreconciled party-account lines with a non-zero residual
-- (residual = amount − Σ pairwise allocations, the S6 model).
CREATE VIEW "v_open_items" WITH (security_invoker = true) AS
SELECT
  ll.team_id,
  ll.id AS line_id,
  a.code AS account_code,
  a.system_key,
  ll.party_type,
  ll.party_id,
  je.date,
  je.entry_number,
  ll.description,
  ll.currency,
  ll.amount_currency,
  ll.debit,
  ll.credit,
  (ll.debit - COALESCE(ad.s, 0)) - (ll.credit - COALESCE(ac.s, 0)) AS residual
FROM ledger_lines ll
JOIN journal_entries je ON je.id = ll.entry_id AND je.status = 'posted'
JOIN gl_accounts a ON a.id = ll.account_id
LEFT JOIN LATERAL (
  SELECT SUM(amount) AS s FROM reconciliation_allocations
   WHERE debit_line_id = ll.id) ad ON true
LEFT JOIN LATERAL (
  SELECT SUM(amount) AS s FROM reconciliation_allocations
   WHERE credit_line_id = ll.id) ac ON true
WHERE ll.reconciliation_id IS NULL
  AND a.system_key IN ('trade_debtors', 'trade_creditors', 'customer_advances', 'supplier_advances')
  AND (ll.debit - COALESCE(ad.s, 0)) - (ll.credit - COALESCE(ac.s, 0)) <> 0;
