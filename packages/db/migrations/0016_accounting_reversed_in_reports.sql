-- Reversed entries stay in the books: 'reversed' marks an entry that has a
-- posted mirror, it does not un-book it. Every aggregate read must therefore
-- include both statuses or a reversal corrupts the reports by dropping one
-- side of the pair. Recreates the four report views from 0013/0014/0015 with
-- status IN ('posted','reversed'). Guards that ask "does this document have a
-- live posting" (opening re-post, double-reversal, unposted-docs close check)
-- correctly keep status = 'posted' and are untouched.

CREATE OR REPLACE VIEW "v_trial_balance" WITH (security_invoker = true) AS
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
JOIN journal_entries je ON je.id = ll.entry_id AND je.status IN ('posted', 'reversed')
JOIN gl_accounts a ON a.id = ll.account_id
GROUP BY ll.team_id, a.id, a.code, a.name, a.type;
--> statement-breakpoint

CREATE OR REPLACE VIEW "v_verworpen_uitgaven" WITH (security_invoker = true) AS
SELECT
  ll.team_id,
  EXTRACT(YEAR FROM je.date)::int AS fiscal_year,
  a.vu_category,
  SUM(ll.debit - ll.credit) AS expense_base,
  vr.deductible_pct,
  ROUND(SUM(ll.debit - ll.credit) * (100 - vr.deductible_pct) / 100, 2) AS disallowed_amount
FROM ledger_lines ll
JOIN journal_entries je ON je.id = ll.entry_id AND je.status IN ('posted', 'reversed')
JOIN gl_accounts a ON a.id = ll.account_id AND a.vu_category IS NOT NULL
LEFT JOIN vu_rates vr ON vr.team_id = ll.team_id
  AND vr.category = a.vu_category
  AND vr.fiscal_year = EXTRACT(YEAR FROM je.date)::int
GROUP BY ll.team_id, EXTRACT(YEAR FROM je.date), a.vu_category, vr.deductible_pct;
--> statement-breakpoint

CREATE OR REPLACE VIEW "v_general_ledger" WITH (security_invoker = true) AS
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
JOIN journal_entries je ON je.id = ll.entry_id AND je.status IN ('posted', 'reversed')
JOIN journals j ON j.id = je.journal_id
JOIN gl_accounts a ON a.id = ll.account_id;
--> statement-breakpoint

CREATE OR REPLACE VIEW "v_open_items" WITH (security_invoker = true) AS
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
JOIN journal_entries je ON je.id = ll.entry_id AND je.status IN ('posted', 'reversed')
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
