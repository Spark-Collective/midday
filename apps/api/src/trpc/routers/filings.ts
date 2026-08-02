import { createTRPCRouter, protectedProcedure } from "@api/trpc/init";
import { primaryDb } from "@midday/db/client";
import {
  buildPersonalTaxPack,
  checkVatProbabilityRules,
  computePersonalTax,
  computeVatGrids,
  generateFilings,
  listFilings,
  markFiled,
  resolvePitValues,
  setFilingData,
  setStep,
  toPitParameters,
  type VatPeriod,
} from "@midday/ledger";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

const pool = () => primaryDb.$client as Pool;

/** Mutations need a dedicated connection (row locks, multi-statement updates). */
async function withClient<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

const stepStatus = z.enum(["todo", "done", "blocked", "skipped"]);

export const filingsRouter = createTRPCRouter({
  /** The year timeline. */
  list: protectedProcedure
    .input(z.object({ year: z.number().int().optional() }).optional())
    .query(async ({ ctx: { teamId }, input }) =>
      listFilings(pool(), { teamId: teamId!, year: input?.year }),
    ),

  /** Create this year's obligations. Idempotent, so the UI can call it freely. */
  generate: protectedProcedure
    .input(
      z.object({
        year: z.number().int(),
        vatRegime: z.enum(["quarterly", "monthly"]).default("quarterly"),
        fiscalYearEndMonth: z.number().int().min(1).max(12).default(12),
      }),
    )
    .mutation(async ({ ctx: { teamId }, input }) =>
      withClient(async (c) => {
        const directors = await c.query(
          `SELECT id FROM directors WHERE team_id = $1 AND active`,
          [teamId],
        );
        return generateFilings(c, {
          teamId: teamId!,
          year: input.year,
          profile: {
            vatRegime: input.vatRegime,
            fiscalYearEndMonth: input.fiscalYearEndMonth,
          },
          directorIds: directors.rows.map((r) => r.id as string),
        });
      }),
    ),

  setStep: protectedProcedure
    .input(
      z.object({
        filingId: z.string().uuid(),
        stepKey: z.string(),
        status: stepStatus,
        note: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx: { teamId }, input }) =>
      withClient((c) => setStep(c, { teamId: teamId!, ...input })),
    ),

  markFiled: protectedProcedure
    .input(
      z.object({
        filingId: z.string().uuid(),
        externalRef: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx: { teamId }, input }) =>
      withClient((c) => markFiled(c, { teamId: teamId!, ...input })),
    ),

  /**
   * Compute the VAT grids for a filing, run the Intervat probability rules, and
   * store both on the row. This is what turns "a deadline" into "a return I can
   * look at" — and it catches the warnings BEFORE Intervat rejects the submission.
   */
  prepareVat: protectedProcedure
    .input(
      z.object({
        filingId: z.string().uuid(),
        year: z.number().int(),
        quarter: z.number().int().min(1).max(4).optional(),
        month: z.number().int().min(1).max(12).optional(),
      }),
    )
    .mutation(async ({ ctx: { teamId }, input }) => {
      const period: VatPeriod = input.quarter
        ? { year: input.year, quarter: input.quarter }
        : { year: input.year, month: input.month };
      const { grids, warnings } = await computeVatGrids(pool(), {
        teamId: teamId!,
        period,
      });
      const probability = checkVatProbabilityRules(grids);
      const payload = { grids, warnings, probability };
      await withClient((c) =>
        setFilingData(c, {
          teamId: teamId!,
          filingId: input.filingId,
          data: payload,
        }),
      );
      return payload;
    }),

  /**
   * Assemble the director's personal return and, when the parameter set for that
   * income year is complete, compute it. The computation is refused rather than
   * approximated when a parameter is missing: a plausible wrong tax figure is the
   * most harmful thing this product could produce.
   */
  preparePersonalTax: protectedProcedure
    .input(
      z.object({
        filingId: z.string().uuid(),
        directorId: z.string().uuid(),
        incomeYear: z.number().int(),
      }),
    )
    .mutation(async ({ ctx: { teamId }, input }) => {
      const pack = await buildPersonalTaxPack(pool(), {
        teamId: teamId!,
        directorId: input.directorId,
        incomeYear: input.incomeYear,
      });

      const dir = await pool().query(
        "SELECT municipality FROM directors WHERE id = $1 AND team_id = $2",
        [input.directorId, teamId],
      );
      const municipality = (dir.rows[0]?.municipality as string | null) ?? "";

      let computation: ReturnType<typeof computePersonalTax> | null = null;
      let parameterGaps: string[] = [];
      if (!municipality) {
        parameterGaps = [
          "The director has no municipality set. The municipal surcharge cannot be resolved, so the tax cannot be computed.",
        ];
      } else {
        const resolved = await resolvePitValues(
          pool(),
          input.incomeYear,
          municipality,
        );
        if (resolved.missing.length > 0) {
          parameterGaps = resolved.missing.map(
            (k: string) => `Missing tax parameter for ${input.incomeYear}: ${k}`,
          );
        } else {
          const params = toPitParameters(
            input.incomeYear,
            resolved.values,
            resolved.municipalSurchargePct!,
            resolved.allVerified,
          );
          computation = computePersonalTax(params, {
            grossRemuneration:
              pack.lines.find((l) => l.boxKey === "remuneration")?.amount ?? 0,
            benefitsInKind:
              pack.lines.find((l) => l.boxKey === "benefitsInKind")?.amount ??
              0,
            personalSocialContributions:
              pack.lines.find((l) => l.boxKey === "socialContributions")
                ?.amount ?? 0,
            withholding: pack.totals.withholding,
            advancePayments: pack.totals.advancePayments,
          });
        }
      }

      const payload = { pack, computation, parameterGaps, municipality };
      await withClient((c) =>
        setFilingData(c, {
          teamId: teamId!,
          filingId: input.filingId,
          data: payload,
        }),
      );
      return payload;
    }),
});
