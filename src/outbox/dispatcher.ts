// Bridges the gap between "durably recorded in Postgres" and "queued in
// Redis" (requirement 3: transactional outbox). Runs entirely inside the API
// process: `publishOnce` is called immediately after a job is created
// (best-effort, low latency), and `startOutboxSweeper` re-runs the same logic
// on an interval so nothing is lost if that immediate attempt fails (e.g.
// Redis was down at submit time) -- see docs/FAILURE_SCENARIOS.md "Redis
// unavailable after acceptance".
import type { Pool } from "pg";
import type { Logger } from "../logger.js";
import { claimUnpublishedOutboxEvents, markOutboxPublishAttempt, markOutboxPublished } from "../db/jobsRepo.js";
import type { QueueSet } from "../queue/queue.js";

export interface DispatcherDeps {
  pool: Pool;
  queues: QueueSet;
  logger: Logger;
  batchSize: number;
}

/**
 * Claims up to `batchSize` unpublished outbox rows (SELECT ... FOR UPDATE
 * SKIP LOCKED, so concurrent sweeps or a future multi-instance API never
 * double-claim the same row), attempts to publish each to BullMQ, and
 * commits the batch's publish/attempt state in one transaction.
 *
 * Duplicate publication: BullMQ jobs are added with `jobId` = the Postgres
 * job id. If the process crashes after a successful `queue.add` but before
 * this transaction commits, the row is retried on the next sweep -- BullMQ
 * sees the same jobId already present (waiting/active/delayed) and treats
 * the second `add` as a no-op rather than creating a duplicate job. The rare
 * case where the first job already *completed and was trimmed* from Redis
 * before the retry lands would re-run the job, but the worker's idempotent,
 * guarded result write (see worker/processor.ts) still yields exactly one
 * authoritative stored result.
 */
export async function publishOnce(deps: DispatcherDeps): Promise<number> {
  const { pool, queues, logger, batchSize } = deps;
  const client = await pool.connect();
  let publishedCount = 0;
  try {
    await client.query("BEGIN");
    const rows = await claimUnpublishedOutboxEvents(client, batchSize);
    for (const row of rows) {
      try {
        const queue = row.payload.isDemo ? queues.demo : queues.main;
        await queue.add(row.payload.jobType, { jobId: row.payload.jobId, jobType: row.payload.jobType }, { jobId: row.payload.jobId });
        await markOutboxPublished(client, row.id);
        publishedCount += 1;
      } catch (err) {
        await markOutboxPublishAttempt(client, row.id);
        logger.warn({ outboxId: row.id, jobId: row.job_id, err: (err as Error).message }, "outbox publish attempt failed, will retry on next sweep");
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    logger.error({ err }, "outbox sweep transaction failed");
  } finally {
    client.release();
  }
  return publishedCount;
}

export interface OutboxSweeper {
  stop: () => void;
}

export function startOutboxSweeper(deps: DispatcherDeps, intervalMs: number): OutboxSweeper {
  let stopped = false;
  let running = false;

  const timer = setInterval(() => {
    if (running || stopped) return;
    running = true;
    publishOnce(deps)
      .catch((err) => deps.logger.error({ err }, "outbox sweep failed unexpectedly"))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
