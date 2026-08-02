import { createTRPCRouter, protectedProcedure } from "@api/trpc/init";
import { primaryDb } from "@midday/db/client";
import {
  createExpenseNote,
  deleteExpenseNote,
  getExpenseNoteById,
  getExpenseNotes,
  updateExpenseNoteStatus,
} from "@midday/db/queries";
import { postExpenseNote } from "@midday/ledger";
import type { Pool } from "pg";
import { z } from "zod";

const lineSchema = z.object({
  description: z.string().min(1),
  glAccountCode: z.string().min(3),
  periodLabel: z.string().optional(),
  category: z.string().optional(),
  quantity: z.number().optional(),
  unit: z.string().optional(),
  unitPrice: z.number().optional(),
  claimPct: z.number().min(0).max(100).optional(),
  amount: z.number().optional(),
  basisNote: z.string().optional(),
});

export const expenseNotesRouter = createTRPCRouter({
  list: protectedProcedure
    .input(
      z
        .object({
          year: z.number().int().min(2000).max(2100).optional(),
          status: z.enum(["draft", "posted", "paid"]).optional(),
        })
        .optional(),
    )
    .query(async ({ ctx: { db, teamId }, input }) =>
      getExpenseNotes(db, {
        teamId: teamId!,
        year: input?.year,
        status: input?.status,
      }),
    ),

  getById: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx: { db, teamId }, input }) =>
      getExpenseNoteById(db, { teamId: teamId!, id: input.id }),
    ),

  create: protectedProcedure
    .input(
      z.object({
        directorId: z.string().uuid().optional(),
        submitterName: z.string().optional(),
        submitterAddress: z.string().optional(),
        submitterIban: z.string().optional(),
        issueDate: z.string().date(),
        periodStart: z.string().date().optional(),
        periodEnd: z.string().date().optional(),
        notes: z.string().optional(),
        lines: z.array(lineSchema).min(1),
      }),
    )
    .mutation(async ({ ctx: { db, teamId }, input }) =>
      createExpenseNote(db, { teamId: teamId!, ...input }),
    ),

  setStatus: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        status: z.enum(["draft", "posted", "paid"]),
      }),
    )
    .mutation(async ({ ctx: { db, teamId }, input }) =>
      updateExpenseNoteStatus(db, {
        teamId: teamId!,
        id: input.id,
        status: input.status,
      }),
    ),

  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx: { db, teamId }, input }) =>
      deleteExpenseNote(db, { teamId: teamId!, id: input.id }),
    ),

  // Book it: Dr each line's cost account / Cr the director's R/C.
  post: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      await updateExpenseNoteStatus(db, {
        teamId: teamId!,
        id: input.id,
        status: "posted",
      });
      const client = await (primaryDb.$client as Pool).connect();
      try {
        return await postExpenseNote(client, {
          expenseNoteId: input.id,
          teamId: teamId!,
        });
      } catch (err) {
        // Roll the label back so a failed post does not leave a lying status.
        await updateExpenseNoteStatus(db, {
          teamId: teamId!,
          id: input.id,
          status: "draft",
        });
        throw err;
      } finally {
        client.release();
      }
    }),
});
