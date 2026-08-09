import { createTRPCRouter, protectedProcedure } from "@api/trpc/init";
import { primaryDb } from "@midday/db/client";
import {
  buildCashForecast,
  copyBudgetForward,
  getBudgetVsActual,
  setBudget,
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

export const cashflowRouter = createTRPCRouter({
  forecast: protectedProcedure
    .input(
      z
        .object({
          weeks: z.number().int().min(1).max(52).optional(),
          months: z.number().int().min(0).max(24).optional(),
        })
        .optional(),
    )
    .query(async ({ ctx: { teamId }, input }) =>
      withClient((c) =>
        buildCashForecast(c, {
          teamId: teamId!,
          weeks: input?.weeks,
          months: input?.months,
        }),
      ),
    ),

  /** Budget against actual for one month, with unbudgeted spend included. */
  budget: protectedProcedure
    .input(z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }))
    .query(async ({ ctx: { teamId }, input }) =>
      withClient((c) =>
        getBudgetVsActual(c, { teamId: teamId!, month: input.month }),
      ),
    ),

  setBudget: protectedProcedure
    .input(
      z.object({
        categorySlug: z.string().min(1),
        month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
        amount: z.number().nonnegative().nullable(),
      }),
    )
    .mutation(async ({ ctx: { teamId }, input }) =>
      withClient((c) => setBudget(c, { teamId: teamId!, ...input })),
    ),

  /** Repeat this month's figure across the rest of the year. */
  copyBudgetForward: protectedProcedure
    .input(
      z.object({
        categorySlug: z.string().min(1),
        month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
      }),
    )
    .mutation(async ({ ctx: { teamId }, input }) =>
      withClient((c) => copyBudgetForward(c, { teamId: teamId!, ...input })),
    ),
});
