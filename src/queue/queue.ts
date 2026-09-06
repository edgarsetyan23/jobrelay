import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import type { Config } from "../config.js";

export interface JobQueueData {
  jobId: string;
  jobType: string;
}

export function createQueue(config: Pick<Config, "MAX_JOB_ATTEMPTS">, connection: Redis, queueName: string): Queue<JobQueueData> {
  return new Queue<JobQueueData>(queueName, {
    connection,
    defaultJobOptions: {
      attempts: config.MAX_JOB_ATTEMPTS,
      // The actual delay math lives in queue/backoff.ts (makeBackoffStrategy),
      // registered on the Worker. "custom" just selects it per job.
      backoff: { type: "custom" },
      // Keep a bounded history in Redis for operational inspection via
      // Bull Board / CLI, but Postgres (jobs + job_attempts) is the
      // authoritative, non-trimmed record -- see docs/ARCHITECTURE.md.
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    },
  });
}

/**
 * JobRelay runs two separate BullMQ queues on the same Redis instance:
 * "main" for normal visitor uploads, and "demo" for jobs created by the
 * interactive failure-demonstration panel. They are entirely separate queues
 * (not a flag on one queue) specifically so the demo queue's dedicated demo
 * workers -- and the "stop this worker" control -- can never touch a normal
 * visitor's job. See docs/ARCHITECTURE.md "Two queues, not one".
 */
export interface QueueSet {
  main: Queue<JobQueueData>;
  demo: Queue<JobQueueData>;
}

export function createQueueSet(config: Pick<Config, "MAX_JOB_ATTEMPTS" | "MAIN_QUEUE_NAME" | "DEMO_QUEUE_NAME">, connection: Redis): QueueSet {
  return {
    main: createQueue(config, connection, config.MAIN_QUEUE_NAME),
    demo: createQueue(config, connection, config.DEMO_QUEUE_NAME),
  };
}
