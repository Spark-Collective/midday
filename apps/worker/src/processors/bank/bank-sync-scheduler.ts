import { createClient } from "@midday/supabase/job";
import { trpc } from "@midday/trpc";
import type { Job } from "bullmq";
import { BaseProcessor } from "../base";

type BankSyncPayload = {
  manualSync?: boolean;
};

type AccountRow = {
  id: string;
  team_id: string;
  account_id: string;
  currency: string | null;
  type: "credit" | "other_asset" | "other_liability" | "depository" | "loan" | null;
  bank_connection: {
    id: string;
    provider: "gocardless" | "plaid" | "teller" | "enablebanking" | "ponto";
    access_token: string | null;
    status: string | null;
  } | null;
};

/**
 * Scheduled bank sync (spark): upstream ran bank syncs on Trigger.dev, which
 * this self-host does not use. This processor ports the essential loop of
 * packages/jobs/src/tasks/bank/sync into the BullMQ worker: for every enabled,
 * non-manual bank account, refresh the balance and upsert the latest
 * transactions through the provider registry (Ponto for Spark's accounts).
 */
export class BankSyncSchedulerProcessor extends BaseProcessor<BankSyncPayload> {
  async process(job: Job<BankSyncPayload>): Promise<{
    accountsSynced: number;
    transactionsUpserted: number;
  }> {
    const supabase = createClient();
    const manualSync = job.data?.manualSync ?? false;

    const { data: accounts } = await supabase
      .from("bank_accounts")
      .select(
        "id, team_id, account_id, currency, type, bank_connection:bank_connection_id(id, provider, access_token, status)",
      )
      .eq("enabled", true)
      .eq("manual", false)
      .throwOnError();

    let accountsSynced = 0;
    let transactionsUpserted = 0;

    for (const account of (accounts ?? []) as unknown as AccountRow[]) {
      const connection = account.bank_connection;
      if (!connection?.provider) continue;

      const accountType = account.type ?? "depository";

      try {
        // 1. Balance
        const balanceResult = await trpc.banking.getBalance.query({
          provider: connection.provider,
          id: account.account_id,
          accessToken: connection.access_token ?? undefined,
          accountType,
        });

        const balance = (balanceResult.data as { amount: number } | null)?.amount ?? null;
        if (balance !== null) {
          await supabase
            .from("bank_accounts")
            .update({ balance, error_details: null, error_retries: null })
            .eq("id", account.id);
        }

        // 2. Transactions (latest page on scheduled runs, full on manual)
        const txResult = await trpc.banking.getProviderTransactions.query({
          provider: connection.provider,
          accountId: account.account_id,
          accountType: accountType === "credit" ? "credit" : "depository",
          accessToken: connection.access_token ?? undefined,
          latest: !manualSync,
        });

        const txs = (txResult.data ?? []) as Array<{
          id: string;
          name: string;
          description: string | null;
          date: string;
          amount: number;
          currency: string;
          method: string;
          category: string | null;
          balance: number | null;
          counterparty_name: string | null;
          merchant_name: string | null;
          status: string;
        }>;

        if (txs.length > 0) {
          const rows = txs.map((t) => ({
            name: t.name,
            description: t.description,
            date: t.date,
            amount: t.amount,
            currency: t.currency,
            method: t.method,
            internal_id: `${account.team_id}_${t.id}`,
            category_slug: t.category,
            bank_account_id: account.id,
            balance: t.balance,
            team_id: account.team_id,
            counterparty_name: t.counterparty_name,
            merchant_name: t.merchant_name,
            status: "posted",
          }));

          const { data: upserted } = await supabase
            .from("transactions")
            // @ts-expect-error - row shape matches table; typed via generated types upstream
            .upsert(rows, { onConflict: "internal_id", ignoreDuplicates: true })
            .select("id")
            .throwOnError();

          transactionsUpserted += upserted?.length ?? 0;
        }

        await supabase
          .from("bank_connections")
          .update({ last_accessed: new Date().toISOString(), status: "connected" })
          .eq("id", connection.id);

        accountsSynced += 1;
      } catch (error) {
        this.logger.error("bank-sync: account failed", {
          accountId: account.account_id,
          provider: connection.provider,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.logger.info("bank-sync completed", { accountsSynced, transactionsUpserted });
    return { accountsSynced, transactionsUpserted };
  }
}
