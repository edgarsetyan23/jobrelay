import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { Worker } from "bullmq";
import { loadConfig } from "../config.js";
import { logger } from "../logger.js";
import { createPool } from "../db/pool.js";
import { deleteWorker, upsertWorkerHeartbeat } from "../db/jobsRepo.js";
import { createWorkerRedisConnection } from "../queue/connection.js";
import { makeBackoffStrategy } from "../queue/backoff.js";
import { makeProcessor } from "./processor.js";
import type { JobQueueData } from "../queue/queue.js";
import { resolveStoragePaths, ensureStorageDirs } from "../storage/paths.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);
  const connection = createWorkerRedisConnection(config);
  const storagePaths = resolveStoragePaths(config.STORAGE_DIR);
  await ensureStorageDirs(storagePaths);

  const kind = config.WORKER_KIND;
  const workerId = config.WORKER_ID_OVERRIDE ?? `${kind}-${hostname()}-${process.pid}-${randomUUID().slice(0, 6)}`;
  const queueName = kind === "demo" ? config.DEMO_QUEUE_NAME : config.MAIN_QUEUE_NAME;

  // The set of jobs this worker currently has in flight -- not just the last
  // one started or finished. With WORKER_CONCURRENCY > 1, a single
  // "currentJobId" variable set on start and cleared on end would report
  // 'idle' the moment *any* job finishes even while others are still
  // running (whichever onJobEnd fires last always wins the clear). Deriving
  // busy/idle from the set's size instead keeps the heartbeat honest at any
  // concurrency.
  const activeJobIds = new Set<string>();

  async function heartbeat(): Promise<void> {
    const status: "idle" | "busy" = activeJobIds.size > 0 ? "busy" : "idle";
    // Only one job id fits the `workers.current_job_id` column; it's a
    // display convenience (see /api/workers), not the source of truth for
    // busy/idle -- that's `status`, above, derived from the whole set.
    const currentJobId = activeJobIds.size > 0 ? [...activeJobIds][0]! : null;
    await upsertWorkerHeartbeat(pool, { id: workerId, kind, pid: process.pid, status, currentJobId }).catch((err) => {
      logger.warn({ err, workerId }, "worker heartbeat failed (will retry on next tick)");
    });
  }

  const processor = makeProcessor({
    pool,
    logger,
    workerId,
    storagePaths,
    imageLimits: {
      maxUploadBytes: config.MAX_UPLOAD_BYTES,
      maxDimensionPx: config.MAX_IMAGE_DIMENSION_PX,
      maxPixels: config.MAX_IMAGE_PIXELS,
    },
    onJobStart: (jobId) => {
      activeJobIds.add(jobId);
      void heartbeat();
    },
    onJobEnd: (jobId) => {
      activeJobIds.delete(jobId);
      void heartbeat();
    },
  });

  const worker = new Worker<JobQueueData>(queueName, processor, {
    connection,
    concurrency: config.WORKER_CONCURRENCY,
    // Crash/stall recovery: if a worker dies mid-job, it stops renewing this
    // job's lock. Once lockDuration elapses without a renewal, BullMQ's
    // stalled-job check (run every stalledInterval by any live worker on
    // this queue) notices, and the job goes back to waiting for another
    // worker to pick up -- up to maxStalledCount times before it is moved to
    // failed outright. See docs/FAILURE_SCENARIOS.md "Worker crash".
    lockDuration: config.LOCK_DURATION_MS,
    stalledInterval: config.STALLED_INTERVAL_MS,
    maxStalledCount: config.MAX_STALLED_COUNT,
    settings: {
      backoffStrategy: makeBackoffStrategy(config),
    },
  });

  worker.on("failed", (job, err) => {
    logger.warn({ jobId: job?.data.jobId, err: err.message }, "bullmq reports job failed");
  });
  worker.on("error", (err) => {
    logger.error({ err }, "bullmq worker error");
  });
  worker.on("stalled", (jobId) => {
    logger.warn({ bullJobId: jobId }, "bullmq reports job stalled -- will be recovered by another attempt");
  });

  await heartbeat();
  const heartbeatTimer = setInterval(() => void heartbeat(), config.WORKER_HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();

  logger.info({ workerId, kind, queue: queueName, concurrency: config.WORKER_CONCURRENCY }, "jobrelay worker started");

  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal, workerId }, "shutting down worker (graceful: waiting for active jobs to finish)");
    clearInterval(heartbeatTimer);
    // worker.close() stops accepting new jobs and waits for in-flight ones to
    // complete (bounded by BullMQ's own shutdown timeout) before resolving.
    await worker.close();
    await deleteWorker(pool, workerId).catch(() => {});
    await pool.end();
    connection.disconnect();
    logger.info({ workerId }, "worker shutdown complete");
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error({ err }, "fatal worker startup error");
  process.exit(1);
});
