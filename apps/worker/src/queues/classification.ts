import { Queue } from "bullmq";
import { classificationQueueConfig } from "./classification.config";

/**
 * Classification queue instance (spark). Separate pool for classify-document /
 * classify-image so process-document (documents queue) never deadlocks waiting
 * on its own child.
 */
export const classificationQueue = new Queue(
  "classification",
  classificationQueueConfig.queueOptions,
);
