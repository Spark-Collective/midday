import {
  createTRPCRouter,
  protectedProcedure,
  publicProcedure,
} from "@api/trpc/init";
import { primaryDb } from "@midday/db/client";
import {
  getProposalByToken,
  listPortalProposals,
  listProposals,
  setProposalStatus,
  upsertProposal,
} from "@midday/ledger";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

const pool = () => primaryDb.$client as Pool;

async function withClient<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

const STATUSES = [
  "draft",
  "sent",
  "accepted",
  "declined",
  "expired",
  "withdrawn",
] as const;

export const proposalsRouter = createTRPCRouter({
  list: protectedProcedure
    .input(
      z
        .object({
          customerId: z.string().uuid().optional(),
          status: z.array(z.enum(STATUSES)).optional(),
        })
        .optional(),
    )
    .query(async ({ ctx: { teamId }, input }) =>
      withClient((c) =>
        listProposals(c, {
          teamId: teamId!,
          customerId: input?.customerId,
          status: input?.status,
        }),
      ),
    ),

  upsert: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid().optional(),
        customerId: z.string().uuid().nullable().optional(),
        projectId: z.string().uuid().nullable().optional(),
        title: z.string().min(1),
        currency: z.string().optional(),
        oneOffAmount: z.number().nonnegative().nullable().optional(),
        recurringAmount: z.number().nonnegative().nullable().optional(),
        recurringInterval: z
          .enum(["month", "quarter", "year"])
          .nullable()
          .optional(),
        recurringMonths: z.number().int().positive().nullable().optional(),
        validUntil: z.string().date().nullable().optional(),
        expectedInvoiceDate: z.string().date().nullable().optional(),
        bodyMd: z.string().nullable().optional(),
        content: z.array(z.unknown()).nullable().optional(),
        sla: z.record(z.string(), z.unknown()).nullable().optional(),
        documentUrl: z.string().url().nullable().optional(),
        vatRate: z.number().min(0).max(100).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx: { teamId }, input }) =>
      withClient((c) => upsertProposal(c, { teamId: teamId!, ...input })),
    ),

  setStatus: protectedProcedure
    .input(
      z.object({
        proposalId: z.string().uuid(),
        status: z.enum(STATUSES),
        expectedInvoiceDate: z.string().date().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx: { teamId }, input }) =>
      withClient((c) => setProposalStatus(c, { teamId: teamId!, ...input })),
    ),

  /**
   * PUBLIC: what a client sees on their own portal page.
   *
   * Scoped entirely by the unguessable portal id, and filtered by an ALLOWLIST
   * of statuses, so an internal draft can never appear here even if a new status
   * is added later.
   */
  portal: publicProcedure
    .input(z.object({ portalId: z.string().min(1) }))
    .query(async ({ input }) =>
      withClient((c) => listPortalProposals(c, { portalId: input.portalId })),
    ),

  /** PUBLIC: one proposal by its share token, for the client-facing page. */
  byToken: publicProcedure
    .input(
      z.object({
        token: z.string().min(1),
        countView: z.boolean().optional(),
      }),
    )
    .query(async ({ input }) =>
      withClient((c) =>
        getProposalByToken(c, {
          token: input.token,
          countView: input.countView,
        }),
      ),
    ),
});
