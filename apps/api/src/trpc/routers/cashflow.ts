import { createTRPCRouter, protectedProcedure } from "@api/trpc/init";
import { primaryDb } from "@midday/db/client";
import { buildCashForecast, snapshotCashForecast } from "@midday/ledger";
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

  /**
   * Landed work: when you expect to bill it and for how much. Clearing the date
   * removes it from the forecast, which is how you retire a project you have
   * finished invoicing.
   */
  setExpectedInvoice: protectedProcedure
    .input(
      z.object({
        projectId: z.string().uuid(),
        expectedInvoiceDate: z.string().date().nullable(),
        contractValue: z.number().nonnegative().nullable(),
      }),
    )
    .mutation(async ({ ctx: { teamId }, input }) =>
      withClient(async (c) => {
        const r = await c.query(
          `UPDATE tracker_projects
              SET expected_invoice_date = $1, contract_value = $2
            WHERE id = $3 AND team_id = $4
            RETURNING id`,
          [
            input.expectedInvoiceDate,
            input.contractValue,
            input.projectId,
            teamId,
          ],
        );
        if (r.rowCount === 0) throw new Error("project not found");
        return r.rows[0];
      }),
    ),

  /** Projects that could carry an expected invoice, with what they carry today. */
  pipeline: protectedProcedure.query(async ({ ctx: { teamId } }) => {
    const r = await pool().query(
      `SELECT p.id, p.name, p.currency,
              p.expected_invoice_date::text AS expected_invoice_date,
              p.contract_value::float8 AS contract_value,
              p.estimate, p.rate::float8 AS rate,
              c.name AS customer_name,
              COALESCE((
                SELECT sum(i.amount) FROM invoices i
                 WHERE i.project_id = p.id AND i.status <> 'canceled'
              ), 0)::float8 AS invoiced
         FROM tracker_projects p
         LEFT JOIN customers c ON c.id = p.customer_id
        WHERE p.team_id = $1 AND p.status <> 'completed'
        ORDER BY p.expected_invoice_date NULLS LAST, p.name`,
      [teamId],
    );
    return r.rows;
  }),

  snapshot: protectedProcedure.mutation(async ({ ctx: { teamId } }) =>
    withClient((c) => snapshotCashForecast(c, { teamId: teamId! })),
  ),

  /**
   * What past forecasts claimed, so the payment-lag model can be scored against
   * what actually happened rather than trusted indefinitely.
   */
  snapshots: protectedProcedure.query(async ({ ctx: { teamId } }) => {
    const r = await pool().query(
      `SELECT taken_on::text AS taken_on, opening_balance::float8 AS opening_balance,
              currency, buckets
         FROM cash_forecast_snapshots
        WHERE team_id = $1
        ORDER BY taken_on DESC
        LIMIT 24`,
      [teamId],
    );
    return r.rows;
  }),
});
