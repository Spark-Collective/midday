/**
 * Post an onkostennota (M10): costs a director paid privately, claimed back
 * from the company.
 *
 *   Dr <line.gl_account_code> per line   /   Cr director R/C (total)
 *
 * No VAT: the underlying supplier invoice is in the director's own name, so
 * the company has no input VAT to deduct. The credit lands on the director's
 * own current account (directors.gl_account_id), which the later payout to
 * their private IBAN reconciles against.
 *
 * Idempotent through the same partial unique index every other document uses
 * (source_type/source_id/source_version WHERE posted), plus the note's own
 * journal_entry_id pointer.
 */
import type { PoolClient } from "pg";
import { cents } from "./money.js";
import { LedgerError, type LineInput, postEntry } from "./post.js";

export type PostExpenseNoteInput = {
  expenseNoteId: string;
  teamId?: string;
  /** Miscellaneous journal, default "800". */
  journalCode?: string;
};

export async function postExpenseNote(
  client: PoolClient,
  input: PostExpenseNoteInput,
): Promise<{ entryId: string; entryNumber: string }> {
  const res = await client.query(
    `SELECT n.id, n.team_id, n.note_number, n.issue_date::text AS issue_date,
            n.total, n.currency, n.status, n.journal_entry_id, n.submitter_name,
            n.director_id, d.name AS director_name, d.gl_account_id AS rc_account_id,
            a.code AS rc_code
       FROM expense_notes n
       LEFT JOIN directors d ON d.id = n.director_id
       LEFT JOIN gl_accounts a ON a.id = d.gl_account_id
      WHERE n.id = $1 AND ($2::uuid IS NULL OR n.team_id = $2)`,
    [input.expenseNoteId, input.teamId ?? null],
  );
  if (res.rowCount === 0) {
    throw new LedgerError(`expense note ${input.expenseNoteId} not found`);
  }
  const note = res.rows[0];

  if (note.journal_entry_id) {
    throw new LedgerError(
      `expense note ${note.note_number} already posted (${note.journal_entry_id})`,
    );
  }
  if (note.status === "draft") {
    throw new LedgerError(
      `expense note ${note.note_number} is a draft; submit it before posting`,
    );
  }
  if (!note.rc_account_id) {
    throw new LedgerError(
      `no R/C account on the director of expense note ${note.note_number}; set directors.gl_account_id first`,
    );
  }

  const linesRes = await client.query(
    `SELECT l.description, l.period_label, l.category, l.gl_account_code,
            l.amount, l.basis_note, a.id AS account_id
       FROM expense_note_lines l
       LEFT JOIN gl_accounts a
         ON a.team_id = l.team_id AND a.code = l.gl_account_code
      WHERE l.expense_note_id = $1
      ORDER BY l.position, l.id`,
    [note.id],
  );
  if (linesRes.rowCount === 0) {
    throw new LedgerError(`expense note ${note.note_number} has no lines`);
  }

  const unknown = linesRes.rows
    .filter((l) => !l.account_id)
    .map((l) => l.gl_account_code);
  if (unknown.length > 0) {
    throw new LedgerError(
      `unknown account code(s) on expense note ${note.note_number}: ${[...new Set(unknown)].join(", ")}`,
    );
  }

  const lines: LineInput[] = [];
  let sum = 0;
  for (const l of linesRes.rows) {
    const amount = Number(l.amount);
    if (!(amount > 0)) continue; // zero lines carry no accounting meaning
    sum += cents(amount);
    lines.push({
      accountId: l.account_id,
      debit: amount,
      description: [l.period_label, l.description].filter(Boolean).join(" - "),
    });
  }
  if (lines.length === 0) {
    throw new LedgerError(
      `expense note ${note.note_number} has no non-zero lines`,
    );
  }

  const total = cents(Number(note.total));
  if (sum !== total) {
    throw new LedgerError(
      `expense note ${note.note_number}: lines sum to ${(sum / 100).toFixed(2)} but total is ${(total / 100).toFixed(2)}`,
    );
  }

  lines.push({
    accountId: note.rc_account_id,
    credit: total / 100,
    partyType: "employee",
    partyId: note.director_id ?? undefined,
    description: `Onkostennota ${note.note_number} - ${note.director_name ?? note.submitter_name}`,
  });

  const entry = await postEntry(client, {
    teamId: note.team_id,
    journalCode: input.journalCode ?? "800",
    date: note.issue_date,
    narration: `Onkostennota ${note.note_number} - ${note.submitter_name}`,
    sourceType: "manual",
    sourceId: note.id,
    lines,
  });

  await client.query(
    `UPDATE expense_notes SET journal_entry_id = $2, updated_at = now() WHERE id = $1`,
    [note.id, entry.entryId],
  );

  return entry;
}
