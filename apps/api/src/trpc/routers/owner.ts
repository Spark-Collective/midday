import { createTRPCRouter, protectedProcedure } from "@api/trpc/init";
import { primaryDb } from "@midday/db/client";
import {
  getOwnerSummary,
  linkDirectorAccounts,
  listDirectors,
  listResidences,
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
           RETURNING id, name, status, municipality, remuneration_monthly, social_insurance_fund`,
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

  /** Personal-side amounts that are not in the company books. */
  items: protectedProcedure
    .input(z.object({ directorId: z.string().uuid(), year: z.number().int() }))
    .query(async ({ ctx: { teamId }, input }) => {
      const r = await pool().query(
        `SELECT id, kind, amount::float8 AS amount, paid_on::text AS paid_on, note
           FROM director_items
          WHERE team_id = $1 AND director_id = $2 AND year = $3
          ORDER BY kind, paid_on NULLS LAST`,
        [teamId, input.directorId, input.year],
      );
      return r.rows as Array<{
        id: string;
        kind: string;
        amount: number;
        paid_on: string | null;
        note: string | null;
      }>;
    }),

  addItem: protectedProcedure
    .input(
      z.object({
        directorId: z.string().uuid(),
        year: z.number().int(),
        kind: z.enum([
          "personal_advance_payment",
          "vapz_premium",
          "social_contribution_personal",
          "actual_expenses",
          "other_income",
          "mortgage",
          "childcare",
          "pension_saving",
          "charitable_gift",
        ]),
        amount: z.number(),
        paidOn: z.string().date().optional(),
        note: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx: { teamId }, input }) =>
      withClient(async (c) => {
        // The director must belong to this team: never trust the id alone.
        const owns = await c.query(
          "SELECT 1 FROM directors WHERE id = $1 AND team_id = $2",
          [input.directorId, teamId],
        );
        if (owns.rowCount === 0) throw new Error("director not found");
        const r = await c.query(
          `INSERT INTO director_items (team_id, director_id, year, kind, amount, paid_on, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [
            teamId,
            input.directorId,
            input.year,
            input.kind,
            input.amount,
            input.paidOn ?? null,
            input.note ?? null,
          ],
        );
        return r.rows[0];
      }),
    ),

  deleteItem: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx: { teamId }, input }) =>
      withClient(async (c) => {
        const r = await c.query(
          "DELETE FROM director_items WHERE id = $1 AND team_id = $2",
          [input.id, teamId],
        );
        return { deleted: r.rowCount ?? 0 };
      }),
    ),

  /**
   * Residence history. The municipal surcharge follows where the director lived
   * on 1 January of the assessment year, so anyone who has moved needs this.
   */
  residences: protectedProcedure
    .input(z.object({ directorId: z.string().uuid() }))
    .query(async ({ ctx: { teamId }, input }) =>
      listResidences(pool(), { teamId: teamId!, directorId: input.directorId }),
    ),

  addResidence: protectedProcedure
    .input(
      z.object({
        directorId: z.string().uuid(),
        municipality: z.string().min(1),
        fromDate: z.string().date(),
        toDate: z.string().date().optional(),
      }),
    )
    .mutation(async ({ ctx: { teamId }, input }) =>
      withClient(async (c) => {
        const owns = await c.query(
          "SELECT 1 FROM directors WHERE id = $1 AND team_id = $2",
          [input.directorId, teamId],
        );
        if (owns.rowCount === 0) throw new Error("director not found");
        try {
          const r = await c.query(
            `INSERT INTO director_residences (team_id, director_id, municipality, from_date, to_date)
             VALUES ($1,$2,$3,$4,$5) RETURNING id`,
            [
              teamId,
              input.directorId,
              input.municipality.trim(),
              input.fromDate,
              input.toDate ?? null,
            ],
          );
          return r.rows[0];
        } catch (err) {
          // The gist EXCLUDE constraint is the real guard; translate it.
          if (String(err).includes("director_residences_no_overlap")) {
            throw new Error(
              "That period overlaps an existing residence. Close the previous one first.",
            );
          }
          throw err;
        }
      }),
    ),

  deleteResidence: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx: { teamId }, input }) =>
      withClient(async (c) => {
        const r = await c.query(
          "DELETE FROM director_residences WHERE id = $1 AND team_id = $2",
          [input.id, teamId],
        );
        return { deleted: r.rowCount ?? 0 };
      }),
    ),
});
