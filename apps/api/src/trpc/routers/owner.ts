import { createTRPCRouter, protectedProcedure } from "@api/trpc/init";
import { primaryDb } from "@midday/db/client";
import {
  getOwnerSummary,
  linkDirectorAccounts,
  listDirectors,
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

export const ownerRouter = createTRPCRouter({
  directors: protectedProcedure.query(async ({ ctx: { teamId } }) =>
    listDirectors(pool(), teamId!),
  ),

  summary: protectedProcedure
    .input(
      z.object({
        directorId: z.string().uuid(),
        year: z.number().int(),
      }),
    )
    .query(async ({ ctx: { teamId }, input }) =>
      getOwnerSummary(pool(), { teamId: teamId!, ...input }),
    ),

  /** Attach the standard PCMN systemKeys so the summary can resolve accounts. */
  linkAccounts: protectedProcedure.mutation(async ({ ctx: { teamId } }) =>
    withClient((c) => linkDirectorAccounts(c, teamId!)),
  ),

  upsertDirector: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid().optional(),
        name: z.string().min(1),
        status: z
          .enum(["hoofdberoep", "bijberoep", "gepensioneerd"])
          .optional(),
        socialInsuranceFund: z.string().optional(),
        remunerationMonthly: z.number().nonnegative().optional(),
        municipality: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx: { teamId }, input }) =>
      withClient(async (c) => {
        const r = await c.query(
          `INSERT INTO directors (team_id, name, status, social_insurance_fund,
                                  remuneration_monthly, municipality)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (team_id, name) DO UPDATE
             SET status = COALESCE(EXCLUDED.status, directors.status),
                 social_insurance_fund = COALESCE(EXCLUDED.social_insurance_fund, directors.social_insurance_fund),
                 remuneration_monthly = COALESCE(EXCLUDED.remuneration_monthly, directors.remuneration_monthly),
                 municipality = COALESCE(EXCLUDED.municipality, directors.municipality)
           RETURNING id, name`,
          [
            teamId,
            input.name,
            input.status ?? null,
            input.socialInsuranceFund ?? null,
            input.remunerationMonthly ?? null,
            input.municipality ?? null,
          ],
        );
        return r.rows[0];
      }),
    ),
});
