import { createTRPCRouter, protectedProcedure } from "@api/trpc/init";
import { primaryDb } from "@midday/db/client";
import {
  computeVatGrids,
  getGeneralLedger,
  getOpenItems,
  getTrialBalance,
} from "@midday/ledger";
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
});
