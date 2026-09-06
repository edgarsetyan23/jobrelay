// Deletes uploaded originals and generated thumbnails for jobs that finished
// more than RETENTION_MINUTES ago. Runs inside the API process on an
// interval, same shape as the outbox sweeper. Only ever deletes files for
// terminal jobs (succeeded/failed) that are actually past retention --
// nothing about an in-flight job is ever touched.
import type { Pool } from "pg";
import { deleteLongStaleWorkers, findJobsNeedingRetentionSweep, markFilesPurged } from "../db/jobsRepo.js";
import { deleteJobFiles, type StoragePaths } from "../storage/paths.js";
import type { Logger } from "../logger.js";

export interface RetentionDeps {
  pool: Pool;
  storagePaths: StoragePaths;
  logger: Logger;
  retentionMinutes: number;
}

/** A worker row this stale almost certainly belongs to a force-killed process, not a live one that's merely slow -- WORKER_OFFLINE_THRESHOLD_MS already marks it "offline" on the board long before this prunes it away entirely. */
const STALE_WORKER_ROW_MAX_AGE_MS = 5 * 60_000;

export async function sweepOnce(deps: RetentionDeps): Promise<number> {
  const cutoff = new Date(Date.now() - deps.retentionMinutes * 60_000);
  const candidates = await findJobsNeedingRetentionSweep(deps.pool, cutoff, 100);
  for (const { id } of candidates) {
    await deleteJobFiles(deps.storagePaths, id).catch((err) => deps.logger.warn({ jobId: id, err }, "retention sweep: failed to delete files (will retry)"));
    await markFilesPurged(deps.pool, id);
  }
  if (candidates.length > 0) {
    deps.logger.info({ count: candidates.length, retentionMinutes: deps.retentionMinutes }, "retention sweep purged job files");
  }

  const prunedWorkers = await deleteLongStaleWorkers(deps.pool, STALE_WORKER_ROW_MAX_AGE_MS).catch(() => 0);
  if (prunedWorkers > 0) {
    deps.logger.info({ count: prunedWorkers }, "retention sweep pruned long-dead worker rows");
  }

  return candidates.length;
}

export interface RetentionSweeper {
  stop: () => void;
}

export function startRetentionSweeper(deps: RetentionDeps, intervalMs: number): RetentionSweeper {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    sweepOnce(deps)
      .catch((err) => deps.logger.error({ err }, "retention sweep failed unexpectedly"))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
