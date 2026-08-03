import { createTRPCRouter, protectedProcedure } from "@api/trpc/init";
import { primaryDb } from "@midday/db/client";
import {
  buildAnnualAccountsXbrl,
  buildClientListing,
  buildClientListingXml,
  buildIcStatement,
  buildIcStatementXml,
  buildPersonalTaxPack,
  checkVatProbabilityRules,
  computePersonalTax,
  computeVatGrids,
  generateFilings,
  generateVatReturn,
  getAnnualAccounts,
  getTaxParameter,
  listFilings,
  markFiled,
  municipalityForIncomeYear,
  resolvePitValues,
  setFilingData,
  setStep,
  skipFiling,
  toPitParameters,
  type VatPeriod,
} from "@midday/ledger";
import {
  API_BASE,
  credsFromEnv,
  isFresh,
  type MinfinEnv,
  refreshToken,
  submitVat,
} from "@midday/minfin";
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

/** Declarant block shared by every Intervat document. */
function declarantFromEnv() {
  const vatNumber = (process.env.LEDGER_VAT_NUMBER ?? "").replace(/\D/g, "");
  if (!vatNumber) throw new Error("LEDGER_VAT_NUMBER not configured");
  return {
    vatNumber,
    name: process.env.LEDGER_COMPANY_NAME ?? "",
    street: process.env.LEDGER_COMPANY_STREET ?? "",
    postCode: process.env.LEDGER_COMPANY_POSTCODE ?? "",
    city: process.env.LEDGER_COMPANY_CITY ?? "",
    countryCode: "BE",
    email: process.env.LEDGER_COMPANY_EMAIL ?? "",
  };
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

  /** "This obligation does not apply for this period" - with a reason. */
  skip: protectedProcedure
    .input(z.object({ filingId: z.string().uuid(), reason: z.string().min(1) }))
    .mutation(async ({ ctx: { teamId }, input }) =>
      withClient((c) => skipFiling(c, { teamId: teamId!, ...input })),
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

      // The municipal surcharge follows residence on 1 Jan of the ASSESSMENT
      // year, not the current address (see municipalityForIncomeYear).
      const residence = await municipalityForIncomeYear(pool(), {
        teamId: teamId!,
        directorId: input.directorId,
        incomeYear: input.incomeYear,
      });
      const municipality = residence.municipality ?? "";

      let computation: ReturnType<typeof computePersonalTax> | null = null;
      let parameterGaps: string[] = [];
      if (!municipality) {
        parameterGaps = [
          `No municipality known for ${residence.referenceDate} (residence on 1 January of the assessment year decides the municipal surcharge). Add the director's residence history under Owner.`,
        ];
      } else {
        const resolved = await resolvePitValues(
          pool(),
          input.incomeYear,
          municipality,
        );
        if (resolved.missing.length > 0) {
          parameterGaps = resolved.missing.map(
            (k: string) =>
              `Missing tax parameter for ${input.incomeYear}: ${k}`,
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

      const payload = {
        pack,
        computation,
        parameterGaps,
        municipality,
        residence,
      };
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
   * Annual accounts: run the NBB micro-model mapping and the Balanscentrale
   * arithmetic controls, and attach the filing-ready XBRL instance.
   *
   * A refused deposit is the expensive failure mode, so failing controls are
   * returned as BLOCKING and the instance is withheld until they pass.
   */
  prepareAnnualAccounts: protectedProcedure
    .input(
      z.object({
        filingId: z.string().uuid(),
        year: z.number().int().min(2000).max(2100),
        compareYear: z.number().int().min(2000).max(2100).optional(),
      }),
    )
    .mutation(async ({ ctx: { teamId }, input }) => {
      const aa = await getAnnualAccounts(pool(), {
        teamId: teamId!,
        year: input.year,
        compareYear: input.compareYear,
      });
      const failed = aa.checks.filter((c) => !c.ok);
      const enterpriseNumber = (process.env.LEDGER_VAT_NUMBER ?? "").replace(
        /\D/g,
        "",
      );

      let xbrl: { xml?: string; filename?: string } | null = null;
      const blocking = failed.map((c) => `${c.name}: ${c.detail}`);
      if (!enterpriseNumber) {
        blocking.push(
          "LEDGER_VAT_NUMBER is not configured, so no XBRL instance can be built.",
        );
      } else if (failed.length === 0) {
        const built = buildAnnualAccountsXbrl({
          declarant: {
            enterpriseNumber,
            name: process.env.LEDGER_COMPANY_NAME ?? "",
          },
          closingDate: `${input.year}-12-31`,
          previousClosingDate: input.compareYear
            ? `${input.compareYear}-12-31`
            : undefined,
          values: aa.values,
        });
        xbrl = { xml: built.xml, filename: built.filename };
      }

      const payload = {
        year: input.year,
        checks: aa.checks,
        blocking,
        rubrieken: aa.values,
        xbrlFilename: xbrl?.filename ?? null,
        // The instance itself can be large; keep it on the filing so the operator
        // can download exactly what was checked.
        xbrl: xbrl?.xml ?? null,
        note: "Depositing the accounts stays a human act on filing.cbso.nbb.be.",
      };
      await withClient((c) =>
        setFilingData(c, {
          teamId: teamId!,
          filingId: input.filingId,
          data: payload,
        }),
      );
      return {
        ...payload,
        // Do not ship the whole instance back through the mutation response.
        xbrl: xbrl ? "(stored on the filing)" : null,
      };
    }),

  /**
   * Submit a periodic VAT return to Intervat, from the app.
   *
   * This is a REAL, irreversible filing to the tax authority, so it is gated on
   * an explicit confirm and refuses when the probability pre-check has unresolved
   * warnings — Intervat would reject those anyway, and a rejected submission is
   * more confusing than a blocked one.
   */
  submitVat: protectedProcedure
    .input(
      z.object({
        filingId: z.string().uuid(),
        year: z.number().int(),
        quarter: z.number().int().min(1).max(4).optional(),
        month: z.number().int().min(1).max(12).optional(),
        confirm: z.literal(true),
        env: z.enum(["test", "prod"]).default("prod"),
        askRestitution: z.enum(["YES", "NO"]).default("NO"),
      }),
    )
    .mutation(async ({ ctx: { teamId }, input }) => {
      const vatNumber = (process.env.LEDGER_VAT_NUMBER ?? "").replace(
        /\D/g,
        "",
      );
      if (!vatNumber) throw new Error("LEDGER_VAT_NUMBER not configured");
      const creds = credsFromEnv();
      const env = input.env as MinfinEnv;

      // Refuse to file something Intervat will bounce.
      const period: VatPeriod = input.quarter
        ? { year: input.year, quarter: input.quarter }
        : { year: input.year, month: input.month };
      const { grids } = await computeVatGrids(pool(), {
        teamId: teamId!,
        period,
      });
      const probability = checkVatProbabilityRules(grids);
      if (probability.length > 0) {
        throw new Error(
          `Intervat would require a justification for: ${probability
            .map((p) => p.code)
            .join(", ")}. Resolve the probability warnings before submitting.`,
        );
      }

      const built = await generateVatReturn(pool(), {
        teamId: teamId!,
        period,
        declarant: {
          vatNumber,
          name: process.env.LEDGER_COMPANY_NAME ?? "",
          street: process.env.LEDGER_COMPANY_STREET ?? "",
          postCode: process.env.LEDGER_COMPANY_POSTCODE ?? "",
          city: process.env.LEDGER_COMPANY_CITY ?? "",
          countryCode: "BE",
          email: process.env.LEDGER_COMPANY_EMAIL ?? "",
        },
        askRestitution: input.askRestitution,
      });

      // Token: refresh when stale, and PERSIST the rotated refresh token before
      // using it — losing it would cost a browser consent with an eID.
      const client = await pool().connect();
      let accessToken: string;
      try {
        const row = await client.query(
          `SELECT refresh_token, access_token, expires_in, obtained_at
             FROM minfin_tokens WHERE team_id = $1 AND env = $2 FOR UPDATE`,
          [teamId, env],
        );
        if (row.rowCount === 0) {
          throw new Error(
            `No MinFin token stored for '${env}'. Run the browser consent once and seed it before submitting from the app.`,
          );
        }
        const cur = row.rows[0];
        if (
          cur.access_token &&
          isFresh({
            obtained_at: Number(cur.obtained_at ?? 0),
            expires_in: Number(cur.expires_in ?? 0),
          })
        ) {
          accessToken = cur.access_token as string;
        } else {
          const t = await refreshToken({
            env,
            creds,
            refreshToken: cur.refresh_token as string,
          });
          await client.query(
            `UPDATE minfin_tokens
                SET refresh_token = $1, access_token = $2, expires_in = $3,
                    obtained_at = $4, scope = $5, updated_at = now()
              WHERE team_id = $6 AND env = $7`,
            [
              t.refresh_token,
              t.access_token,
              t.expires_in,
              t.obtained_at,
              t.scope ?? null,
              teamId,
              env,
            ],
          );
          accessToken = t.access_token;
        }
      } finally {
        client.release();
      }

      const periodLabel = input.quarter
        ? `${input.year}Q${input.quarter}`
        : `${input.year}M${String(input.month).padStart(2, "0")}`;
      const ref = await submitVat({
        apiBase: API_BASE[env],
        accessToken,
        vatNumber,
        content: Buffer.from(built.xml, "utf8"),
        filename: `vat-${periodLabel}.xml`,
        lang: "nl",
      });

      await withClient(async (c) => {
        await setFilingData(c, {
          teamId: teamId!,
          filingId: input.filingId,
          data: {
            grids: built.grids,
            warnings: built.warnings,
            probability: [],
            submitted: ref,
          },
        });
        await markFiled(c, {
          teamId: teamId!,
          filingId: input.filingId,
          externalRef: ref.xmlReference,
          artifacts: [
            { label: "Intervat proof (PDF)", reference: ref.pdfReference },
            { label: "Intervat proof (XML)", reference: ref.xmlReference },
          ],
        });
      });
      return ref;
    }),

  /**
   * Client listing (`lc`) and IC statement (`ico`): build from the invoice
   * sub-ledger, show the operator what will be filed, and store it on the filing.
   * Submission reuses the same Intervat path as the VAT return.
   */
  prepareListing: protectedProcedure
    .input(
      z.object({
        filingId: z.string().uuid(),
        kind: z.enum(["client_listing", "ic_statement"]),
        year: z.number().int(),
        quarter: z.number().int().min(1).max(4).optional(),
        month: z.number().int().min(1).max(12).optional(),
        icCode: z.enum(["L", "S", "T"]).optional(),
      }),
    )
    .mutation(async ({ ctx: { teamId }, input }) => {
      const declarant = declarantFromEnv();
      let payload: Record<string, unknown>;

      if (input.kind === "client_listing") {
        // Threshold is a tax parameter, never a literal.
        let threshold = 250;
        try {
          threshold = (
            await getTaxParameter(
              pool(),
              input.year,
              "client_listing_threshold",
            )
          ).value;
        } catch {
          // Fall back to the statutory default, and say so.
        }
        const listing = await buildClientListing(pool(), {
          teamId: teamId!,
          year: input.year,
          threshold,
        });
        payload = {
          kind: input.kind,
          threshold,
          rows: listing.rows,
          turnoverSum: listing.turnoverSum,
          vatSum: listing.vatSum,
          warnings: listing.warnings,
          xml: buildClientListingXml({ declarant, listing }),
        };
      } else {
        const statement = await buildIcStatement(pool(), {
          teamId: teamId!,
          year: input.year,
          quarter: input.quarter,
          month: input.month,
          defaultCode: input.icCode,
        });
        payload = {
          kind: input.kind,
          rows: statement.rows,
          amountSum: statement.amountSum,
          warnings: statement.warnings,
          xml: buildIcStatementXml({ declarant, statement }),
        };
      }

      await withClient((c) =>
        setFilingData(c, {
          teamId: teamId!,
          filingId: input.filingId,
          data: payload,
        }),
      );
      return { ...payload, xml: "(stored on the filing)" };
    }),

  /** Submit a prepared listing to Intervat (declarationType lc / ico). */
  submitListing: protectedProcedure
    .input(
      z.object({
        filingId: z.string().uuid(),
        kind: z.enum(["client_listing", "ic_statement"]),
        confirm: z.literal(true),
        env: z.enum(["test", "prod"]).default("prod"),
      }),
    )
    .mutation(async ({ ctx: { teamId }, input }) => {
      const declarant = declarantFromEnv();
      const creds = credsFromEnv();
      const env = input.env as MinfinEnv;

      const client = await pool().connect();
      let accessToken: string;
      let xml: string;
      try {
        const f = await client.query(
          "SELECT data, period_key FROM filings WHERE id = $1 AND team_id = $2",
          [input.filingId, teamId],
        );
        const data = f.rows[0]?.data as { xml?: string } | null;
        if (!data?.xml) {
          throw new Error(
            "Nothing prepared yet: build the listing before submitting it.",
          );
        }
        xml = data.xml;

        const row = await client.query(
          `SELECT refresh_token, access_token, expires_in, obtained_at
             FROM minfin_tokens WHERE team_id = $1 AND env = $2 FOR UPDATE`,
          [teamId, env],
        );
        if (row.rowCount === 0) {
          throw new Error(`No MinFin token stored for '${env}'.`);
        }
        const cur = row.rows[0];
        if (
          cur.access_token &&
          isFresh({
            obtained_at: Number(cur.obtained_at ?? 0),
            expires_in: Number(cur.expires_in ?? 0),
          })
        ) {
          accessToken = cur.access_token as string;
        } else {
          const t = await refreshToken({
            env,
            creds,
            refreshToken: cur.refresh_token as string,
          });
          await client.query(
            `UPDATE minfin_tokens SET refresh_token=$1, access_token=$2,
                    expires_in=$3, obtained_at=$4, scope=$5, updated_at=now()
              WHERE team_id=$6 AND env=$7`,
            [
              t.refresh_token,
              t.access_token,
              t.expires_in,
              t.obtained_at,
              t.scope ?? null,
              teamId,
              env,
            ],
          );
          accessToken = t.access_token;
        }
      } finally {
        client.release();
      }

      const declarationType = input.kind === "client_listing" ? "lc" : "ico";
      const ref = await submitVat({
        apiBase: API_BASE[env],
        accessToken,
        vatNumber: declarant.vatNumber,
        content: Buffer.from(xml, "utf8"),
        filename: `${declarationType}.xml`,
        lang: "nl",
        declarationType,
      });

      await withClient((c) =>
        markFiled(c, {
          teamId: teamId!,
          filingId: input.filingId,
          externalRef: ref.xmlReference,
          artifacts: [
            { label: "Intervat proof (PDF)", reference: ref.pdfReference },
            { label: "Intervat proof (XML)", reference: ref.xmlReference },
          ],
        }),
      );
      return ref;
    }),
});
