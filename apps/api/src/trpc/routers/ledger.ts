import { createTRPCRouter, protectedProcedure } from "@api/trpc/init";
import { primaryDb } from "@midday/db/client";
import {
  closePeriod,
  computeVatGrids,
  generateVatReturn,
  getGeneralLedger,
  getOpenItems,
  getOverview,
  getStatement,
  getTrialBalance,
} from "@midday/ledger";
import type { Pool } from "pg";
import { z } from "zod";

// Read-only ledger reports. Raw parameterised SQL over the accounting views
// needs the underlying pg Pool; reads are transaction-free, so the shared
// primary pool is safe (LedgerDb interface).
const ledgerDb = () => primaryDb.$client;

export const ledgerRouter = createTRPCRouter({
  trialBalance: protectedProcedure
    .input(
      z
        .object({
          from: z.string().date().optional(),
          to: z.string().date().optional(),
        })
        .optional(),
    )
    .query(async ({ ctx: { teamId }, input }) => {
      return getTrialBalance(ledgerDb(), {
        teamId: teamId!,
        from: input?.from,
        to: input?.to,
      });
    }),

  generalLedger: protectedProcedure
    .input(
      z
        .object({
          accountCode: z.string().optional(),
          from: z.string().date().optional(),
          to: z.string().date().optional(),
          limit: z.number().min(1).max(500).optional(),
        })
        .optional(),
    )
    .query(async ({ ctx: { teamId }, input }) => {
      return getGeneralLedger(ledgerDb(), {
        teamId: teamId!,
        accountCode: input?.accountCode,
        from: input?.from,
        to: input?.to,
        limit: input?.limit,
      });
    }),

  openItems: protectedProcedure
    .input(
      z
        .object({ partyType: z.enum(["customer", "supplier"]).optional() })
        .optional(),
    )
    .query(async ({ ctx: { teamId }, input }) => {
      return getOpenItems(ledgerDb(), {
        teamId: teamId!,
        partyType: input?.partyType,
      });
    }),

  vatReturn: protectedProcedure
    .input(
      z.object({
        year: z.number().int().min(2000).max(2100),
        quarter: z.number().int().min(1).max(4),
      }),
    )
    .query(async ({ ctx: { teamId }, input }) => {
      return computeVatGrids(ledgerDb(), {
        teamId: teamId!,
        period: { year: input.year, quarter: input.quarter },
      });
    }),

  // Intervat-ready VATConsignment XML. Declarant details come from env
  // (self-host, single company); submission itself stays outside the platform.
  vatReturnXml: protectedProcedure
    .input(
      z.object({
        year: z.number().int().min(2000).max(2100),
        quarter: z.number().int().min(1).max(4),
      }),
    )
    .query(async ({ ctx: { teamId }, input }) => {
      const declarant = {
        vatNumber: process.env.LEDGER_VAT_NUMBER ?? "",
        name: process.env.LEDGER_COMPANY_NAME ?? "",
        street: process.env.LEDGER_COMPANY_STREET ?? "",
        postCode: process.env.LEDGER_COMPANY_POSTCODE ?? "",
        city: process.env.LEDGER_COMPANY_CITY ?? "",
        email: process.env.LEDGER_COMPANY_EMAIL ?? "",
      };
      if (!declarant.vatNumber || !declarant.name) {
        throw new Error(
          "LEDGER_VAT_NUMBER / LEDGER_COMPANY_* env vars not configured",
        );
      }
      const result = await generateVatReturn(ledgerDb(), {
        teamId: teamId!,
        period: { year: input.year, quarter: input.quarter },
        declarant,
      });
      return {
        xml: result.xml,
        grids: result.grids,
        warnings: result.warnings,
        filename: `intervat-${input.year}-Q${input.quarter}.xml`,
      };
    }),

  // Grouped financial statements (M7): resultatenrekening + balans, with an
  // optional comparison year. The current year is cut at today (YTD).
  statement: protectedProcedure
    .input(
      z.object({
        kind: z.enum(["income", "balance"]),
        year: z.number().int().min(2000).max(2100),
        compareYear: z.number().int().min(2000).max(2100).optional(),
      }),
    )
    .query(async ({ ctx: { teamId }, input }) => {
      const today = new Date().toISOString().slice(0, 10);
      const bound = (year: number) => {
        const to = today.startsWith(String(year)) ? today : `${year}-12-31`;
        return input.kind === "income"
          ? { from: `${year}-01-01`, to, label: String(year) }
          : { to, label: String(year) };
      };
      const periods = [bound(input.year)];
      if (input.compareYear) periods.push(bound(input.compareYear));
      return getStatement(ledgerDb(), {
        teamId: teamId!,
        kind: input.kind,
        periods,
      });
    }),

  overview: protectedProcedure
    .input(z.object({ year: z.number().int().min(2000).max(2100) }))
    .query(async ({ ctx: { teamId }, input }) => {
      return getOverview(ledgerDb(), { teamId: teamId!, year: input.year });
    }),

  // The close cockpit: month statuses + what still blocks a close.
  periods: protectedProcedure
    .input(z.object({ year: z.number().int().min(2000).max(2100) }))
    .query(async ({ ctx: { teamId }, input }) => {
      const r = await ledgerDb().query(
        `SELECT fp.month, fp.status,
                (SELECT COUNT(*)::int FROM journal_entries je
                  WHERE je.team_id = fp.team_id AND je.status IN ('posted','reversed')
                    AND EXTRACT(YEAR FROM je.date) = fp.year
                    AND EXTRACT(MONTH FROM je.date) = fp.month) AS entries,
                (SELECT COUNT(*)::int FROM transactions t
                  WHERE t.team_id = fp.team_id AND t.status = 'posted' AND t.amount <> 0
                    AND EXTRACT(YEAR FROM t.date) = fp.year
                    AND EXTRACT(MONTH FROM t.date) = fp.month
                    AND NOT EXISTS (SELECT 1 FROM journal_entries je
                                     WHERE je.team_id = t.team_id
                                       AND je.source_type = 'transaction'
                                       AND je.source_id = t.id
                                       AND je.status = 'posted')) AS unbooked
           FROM fiscal_periods fp
          WHERE fp.team_id = $1 AND fp.year = $2
          ORDER BY fp.month`,
        [teamId, input.year],
      );
      return r.rows as Array<{
        month: number;
        status: string;
        entries: number;
        unbooked: number;
      }>;
    }),

  closePeriod: protectedProcedure
    .input(
      z.object({
        year: z.number().int().min(2000).max(2100),
        month: z.number().int().min(1).max(12),
        force: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx: { teamId }, input }) => {
      const client = await (ledgerDb() as unknown as Pool).connect();
      try {
        return await closePeriod(client, {
          teamId: teamId!,
          year: input.year,
          month: input.month,
          force: input.force,
        });
      } finally {
        client.release();
      }
    }),

  reopenPeriod: protectedProcedure
    .input(
      z.object({
        year: z.number().int().min(2000).max(2100),
        month: z.number().int().min(1).max(12),
      }),
    )
    .mutation(async ({ ctx: { teamId }, input }) => {
      const r = await ledgerDb().query(
        `UPDATE fiscal_periods SET status = 'open'
          WHERE team_id = $1 AND year = $2 AND month = $3 AND status = 'closed'
          RETURNING month`,
        [teamId, input.year, input.month],
      );
      return { reopened: (r.rowCount ?? 0) > 0 };
    }),
});
