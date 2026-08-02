/**
 * Onkostennota queries (M10). The header/lines pair is written as one unit:
 * a note's total is always the sum of its lines, never a free-typed figure.
 *
 * Line maths lives in `computeLineAmount`: either a flat amount or
 * quantity x unit_price, then scaled by the claimed business percentage. The
 * PDF prints the same inputs back as the calculation detail, so the document
 * carries its own justification (the point of the exercise for EV home
 * charging, where a bare monthly figure does not hold up).
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Database } from "../client";
import { directors, expenseNoteLines, expenseNotes } from "../schema";

export type ExpenseNoteLineInput = {
  description: string;
  glAccountCode: string;
  periodLabel?: string | null;
  category?: string | null;
  quantity?: number | null;
  unit?: string | null;
  unitPrice?: number | null;
  claimPct?: number | null;
  /** Used when quantity/unitPrice are absent (a flat claim). */
  amount?: number | null;
  basisNote?: string | null;
};

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** quantity x unit_price (or the flat amount), scaled by the claimed share. */
export function computeLineAmount(line: ExpenseNoteLineInput): number {
  const pct = line.claimPct ?? 100;
  const gross =
    line.quantity != null && line.unitPrice != null
      ? line.quantity * line.unitPrice
      : (line.amount ?? 0);
  return r2(gross * (pct / 100));
}

/** The transaction handle drizzle hands to `db.transaction`. */
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

async function nextNumber(db: Tx, teamId: string, year: number) {
  const [row] = await db
    .select({ maxSeq: sql<number>`COALESCE(MAX(${expenseNotes.seq}), 0)` })
    .from(expenseNotes)
    .where(and(eq(expenseNotes.teamId, teamId), eq(expenseNotes.year, year)));
  const seq = (row?.maxSeq ?? 0) + 1;
  return { seq, noteNumber: `${year}-${String(seq).padStart(3, "0")}` };
}

export type CreateExpenseNoteParams = {
  teamId: string;
  directorId?: string | null;
  submitterName?: string | null;
  submitterAddress?: string | null;
  submitterIban?: string | null;
  issueDate: string;
  periodStart?: string | null;
  periodEnd?: string | null;
  notes?: string | null;
  lines: ExpenseNoteLineInput[];
};

export async function createExpenseNote(
  db: Database,
  params: CreateExpenseNoteParams,
) {
  const year = Number(params.issueDate.slice(0, 4));

  // Letterhead defaults come from the director record when not given.
  let submitter = params.submitterName ?? null;
  if (!submitter && params.directorId) {
    const [d] = await db
      .select({ name: directors.name })
      .from(directors)
      .where(
        and(
          eq(directors.id, params.directorId),
          eq(directors.teamId, params.teamId),
        ),
      );
    submitter = d?.name ?? null;
  }
  if (!submitter) throw new Error("expense note needs a submitter");

  const amounts = params.lines.map(computeLineAmount);
  const total = r2(amounts.reduce((s, a) => s + a, 0));

  return db.transaction(async (tx) => {
    const { seq, noteNumber } = await nextNumber(tx, params.teamId, year);
    const [note] = await tx
      .insert(expenseNotes)
      .values({
        teamId: params.teamId,
        directorId: params.directorId ?? null,
        submitterName: submitter,
        submitterAddress: params.submitterAddress ?? null,
        submitterIban: params.submitterIban ?? null,
        year,
        seq,
        noteNumber,
        issueDate: params.issueDate,
        periodStart: params.periodStart ?? null,
        periodEnd: params.periodEnd ?? null,
        notes: params.notes ?? null,
        total,
      })
      .returning();

    if (params.lines.length > 0) {
      await tx.insert(expenseNoteLines).values(
        params.lines.map((l, i) => ({
          expenseNoteId: note!.id,
          teamId: params.teamId,
          position: i,
          description: l.description,
          periodLabel: l.periodLabel ?? null,
          category: l.category ?? null,
          glAccountCode: l.glAccountCode,
          quantity: l.quantity ?? null,
          unit: l.unit ?? null,
          unitPrice: l.unitPrice ?? null,
          claimPct: l.claimPct ?? 100,
          amount: amounts[i]!,
          basisNote: l.basisNote ?? null,
        })),
      );
    }
    return note;
  });
}

export async function getExpenseNotes(
  db: Database,
  params: { teamId: string; year?: number; status?: string },
) {
  const conditions = [eq(expenseNotes.teamId, params.teamId)];
  if (params.year) conditions.push(eq(expenseNotes.year, params.year));
  if (params.status) conditions.push(eq(expenseNotes.status, params.status));
  return db
    .select()
    .from(expenseNotes)
    .where(and(...conditions))
    .orderBy(desc(expenseNotes.issueDate), desc(expenseNotes.seq));
}

export async function getExpenseNoteById(
  db: Database,
  params: { teamId: string; id: string },
) {
  const [note] = await db
    .select()
    .from(expenseNotes)
    .where(
      and(eq(expenseNotes.id, params.id), eq(expenseNotes.teamId, params.teamId)),
    );
  if (!note) return null;
  const lines = await db
    .select()
    .from(expenseNoteLines)
    .where(eq(expenseNoteLines.expenseNoteId, note.id))
    .orderBy(asc(expenseNoteLines.position));
  return { ...note, lines };
}

/** draft -> posted happens through the ledger; this only flips the label. */
export async function updateExpenseNoteStatus(
  db: Database,
  params: { teamId: string; id: string; status: "draft" | "posted" | "paid" },
) {
  const [row] = await db
    .update(expenseNotes)
    .set({ status: params.status, updatedAt: new Date().toISOString() })
    .where(
      and(eq(expenseNotes.id, params.id), eq(expenseNotes.teamId, params.teamId)),
    )
    .returning();
  return row ?? null;
}

export async function deleteExpenseNote(
  db: Database,
  params: { teamId: string; id: string },
) {
  // The DB trigger refuses to delete a booked note; surface that as null.
  const [row] = await db
    .delete(expenseNotes)
    .where(
      and(eq(expenseNotes.id, params.id), eq(expenseNotes.teamId, params.teamId)),
    )
    .returning();
  return row ?? null;
}
