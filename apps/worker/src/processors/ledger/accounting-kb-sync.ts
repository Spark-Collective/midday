import { primaryDb } from "@midday/db/client";
import { syncAccountingKb } from "@midday/documents/kb";
import type { Job } from "bullmq";
import type { Pool } from "pg";
import { BaseProcessor } from "../base";

/**
 * Keep the indexed Belgian accounting KB in step with its GitHub repo.
 *
 * Hourly, and almost always free: the job compares the repo's head sha with
 * what we indexed and stops there when nothing moved (one HTTP request). Only
 * a real change costs anything, and even then only the files whose blob sha
 * differs are downloaded and re-embedded.
 *
 * Freshness matters more here than for most caches: the KB is what stops the
 * assistant inventing Belgian tax rules, so an index quietly stuck three
 * months behind is worse than an obviously empty one. Failures are recorded
 * on kb_sync_state.last_error AND thrown, so a broken sync shows up as a
 * failed job instead of a silently ageing answer.
 */
export class AccountingKbSyncProcessor extends BaseProcessor<{
  force?: boolean;
}> {
  async process(job: Job<{ force?: boolean }>): Promise<unknown> {
    const pool = primaryDb.$client as Pool;
    const result = await syncAccountingKb(pool, {
      force: job.data?.force === true,
    });

    if (result.status === "unchanged") {
      this.logger.info("accounting-kb: unchanged", {
        commit: result.commitSha.slice(0, 7),
        documents: result.total,
      });
    } else {
      this.logger.info("accounting-kb: synced", {
        commit: result.commitSha.slice(0, 7),
        changed: result.changed,
        deleted: result.deleted,
        documents: result.total,
      });
    }

    return result;
  }
}
