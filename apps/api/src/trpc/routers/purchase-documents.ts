import { createTRPCRouter, protectedProcedure } from "@api/trpc/init";
import { primaryDb } from "@midday/db/client";
import {
  createPurchaseDocument,
  deletePurchaseDocument,
  getPurchaseDocumentById,
  getPurchaseDocuments,
} from "@midday/db/queries";
import { inbox, purchaseDocuments } from "@midday/db/schema";
import {
  getOpenSupplierItems,
  postPurchaseDocument,
  settlePurchaseDocuments,
} from "@midday/ledger";
import { and, eq, inArray, isNotNull, isNull, not } from "drizzle-orm";
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

  // What is still open on 440000 per supplier, with matching unbooked
  // bank transactions as settlement candidates.
  openItems: protectedProcedure.query(async ({ ctx: { teamId } }) => {
    const client = await (primaryDb.$client as Pool).connect();
    try {
      return await getOpenSupplierItems(client, { teamId: teamId! });
    } finally {
      client.release();
    }
  }),

  // One click: book the payment to 440000 and reconcile it against the
  // documents. Strict: the amount must match the net open to the cent.
  settle: protectedProcedure
    .input(
      z.object({
        transactionId: z.string().uuid(),
        documentIds: z.array(z.string().uuid()).min(1),
      }),
    )
    .mutation(async ({ ctx: { teamId }, input }) => {
      const client = await (primaryDb.$client as Pool).connect();
      try {
        return await settlePurchaseDocuments(client, {
          teamId: teamId!,
          transactionId: input.transactionId,
          documentIds: input.documentIds,
        });
      } finally {
        client.release();
      }
    }),

  // Financial inbox items not yet matched to a transaction nor booked as a
  // purchase document: the "book as purchase document" candidates.
  inboxCandidates: protectedProcedure.query(
    async ({ ctx: { db, teamId } }) => {
      const used = await db
        .select({ inboxId: purchaseDocuments.inboxId })
        .from(purchaseDocuments)
        .where(
          and(
            eq(purchaseDocuments.teamId, teamId!),
            isNotNull(purchaseDocuments.inboxId),
          ),
        );
      const usedIds = used
        .map((u) => u.inboxId)
        .filter((x): x is string => x !== null);

      const rows = await db
        .select({
          id: inbox.id,
          displayName: inbox.displayName,
          amount: inbox.amount,
          taxAmount: inbox.taxAmount,
          taxRate: inbox.taxRate,
          currency: inbox.currency,
          date: inbox.date,
          invoiceNumber: inbox.invoiceNumber,
          type: inbox.type,
          billingReference: inbox.billingReference,
        })
        .from(inbox)
        .where(
          and(
            eq(inbox.teamId, teamId!),
            isNull(inbox.transactionId),
            isNotNull(inbox.amount),
            not(inArray(inbox.status, ["deleted", "done", "archived"])),
            ...(usedIds.length > 0 ? [not(inArray(inbox.id, usedIds))] : []),
          ),
        )
        .orderBy(inbox.createdAt);
      return rows.filter((r) => r.type !== "other");
    },
  ),
});
