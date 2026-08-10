import { createTRPCRouter, protectedProcedure } from "@api/trpc/init";
import { primaryDb } from "@midday/db/client";
import {
  createPurchaseDocument,
  deletePurchaseDocument,
  getPurchaseDocumentById,
  getPurchaseDocuments,
} from "@midday/db/queries";
import { postPurchaseDocument } from "@midday/ledger";
import type { Pool } from "pg";
import { z } from "zod";

const lineSchema = z.object({
  description: z.string().min(1),
  glAccountCode: z.string().min(3),
  amount: z.number().positive(),
  taxCode: z.string().optional(),
  taxAmount: z.number().min(0).optional(),
});

export const purchaseDocumentsRouter = createTRPCRouter({
  list: protectedProcedure
    .input(
      z
        .object({
          status: z.enum(["draft", "posted", "settled"]).optional(),
          kind: z.enum(["invoice", "credit_note"]).optional(),
        })
        .optional(),
    )
    .query(async ({ ctx: { db, teamId }, input }) =>
      getPurchaseDocuments(db, {
        teamId: teamId!,
        status: input?.status,
        kind: input?.kind,
      }),
    ),

  getById: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx: { db, teamId }, input }) =>
      getPurchaseDocumentById(db, { teamId: teamId!, id: input.id }),
    ),

  create: protectedProcedure
    .input(
      z.object({
        supplierName: z.string().min(1),
        supplierVat: z.string().optional(),
        documentNumber: z.string().min(1),
        kind: z.enum(["invoice", "credit_note"]),
        creditsDocumentId: z.string().uuid().optional(),
        creditsDocumentNumber: z.string().optional(),
        issueDate: z.string().date(),
        dueDate: z.string().date().optional(),
        currency: z.string().length(3).optional(),
        inboxId: z.string().uuid().optional(),
        notes: z.string().optional(),
        lines: z.array(lineSchema).min(1),
      }),
    )
    .mutation(async ({ ctx: { db, teamId }, input }) =>
      createPurchaseDocument(db, { teamId: teamId!, ...input }),
    ),

  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx: { db, teamId }, input }) =>
      deletePurchaseDocument(db, { teamId: teamId!, id: input.id }),
    ),

  // Book it: Dr cost + Dr deductible VAT / Cr 440000 (credit note mirrors).
  post: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx: { teamId }, input }) => {
      const client = await (primaryDb.$client as Pool).connect();
      try {
        return await postPurchaseDocument(client, {
          purchaseDocumentId: input.id,
          teamId: teamId!,
        });
      } finally {
        client.release();
      }
    }),
});
