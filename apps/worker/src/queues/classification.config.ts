import { createLoggerWithContext } from "@midday/logger";
import type { QueueOptions, WorkerOptions } from "bullmq";
import { getRedisConnection } from "../config";
import type { QueueConfig } from "../types/queue-config";

const logger = createLoggerWithContext("worker:queue:classification");

/**
 * Classification queue (spark): classify-document / classify-image run here,
 * OFF the documents queue. process-document (on `documents`) blocks on its
 * classify child via triggerJobAndWait; if the child shares the documents
 * pool, ≥concurrency parents deadlock (parents hold every slot waiting for
 * children that can't start). A separate pool breaks that cycle.
 */
const classificationQueueOptions: QueueOptions = {
  connection: getRedisConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: { age: 24 * 3600, count: 1000 },
    removeOnFail: { age: 7 * 24 * 3600 },
  },
};

const classificationWorkerOptions: WorkerOptions = {
  connection: getRedisConnection(),
  concurrency: 10,
  lockDuration: 660000,
  stalledInterval: 720000,
};

export const classificationQueueConfig: QueueConfig = {
  name: "classification",
  queueOptions: classificationQueueOptions,
  workerOptions: classificationWorkerOptions,
  eventHandlers: {
    onFailed: (job, err) => {
      logger.error("Job failed", {
        jobName: job?.name,
        jobId: job?.id,
        error: err.message,
      });
    },
  },
};
