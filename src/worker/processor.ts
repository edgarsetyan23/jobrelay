// The actual per-job work, independent of BullMQ's Job wrapper so it's easy
// to reason about and unit-test the transition logic. See docs/ARCHITECTURE.md
// "Life of a job" for the full state diagram this function implements.
import type { Job } from "bullmq";
import { UnrecoverableError } from "bullmq";
import type { Pool } from "pg";
import {
  getJobById,
  recordAttemptEnd,
  recordAttemptStart,
  transitionToFailed,
  transitionToRetrying,
  transitionToRunning,
  transitionToSucceeded,
} from "../db/jobsRepo.js";
import { generateThumbnails, ValidationError, type ImageLimits } from "../jobs/thumbnails.js";
import { applyFault, type FaultSpec } from "../faults/inject.js";
import { metrics } from "../metrics/metrics.js";
import type { Logger } from "../logger.js";
import type { JobQueueData } from "../queue/queue.js";
import { thumbnailPathFor, uploadPathFor, type StoragePaths } from "../storage/paths.js";

export interface ImageJobPayload {
  /** Display-only, sanitized client-supplied filename. Never used to build a filesystem path. */
  originalFilename: string;
  fileSizeBytes: number;
  /** Only ever honored for jobs on the demo queue -- see the header comment in src/faults/inject.ts. */
  _fault?: FaultSpec;
}

export interface ProcessorDeps {
  pool: Pool;
  logger: Logger;
  workerId: string;
  storagePaths: StoragePaths;
  imageLimits: ImageLimits;
  /** Called right before/after processing so the worker can heartbeat its busy/idle status. */
  onJobStart?: (jobId: string) => void;
  onJobEnd?: () => void;
}

export function makeProcessor(deps: ProcessorDeps) {
  return async function processJob(job: Job<JobQueueData>): Promise<unknown> {
    const jobId = job.data.jobId;
    const attemptNumber = job.attemptsMade + 1;
    deps.onJobStart?.(jobId);

    try {
      const record = await getJobById(deps.pool, jobId);
      if (!record) {
        // The outbox published an event for a job row that no longer exists.
        // Should not happen under normal operation (jobs are never deleted),
        // but if it did, retrying forever would be worse than giving up.
        throw new UnrecoverableError(`no job record found in postgres for id ${jobId}`);
      }

      if (record.status === "succeeded" || record.status === "failed") {
        // Duplicate delivery of an already-terminal job (e.g. re-publish
        // after an outbox-transaction rollback raced a successful
        // queue.add, or a stale worker retry landing after another worker
        // already finished). One authoritative result already exists in
        // Postgres -- do nothing.
        deps.logger.info({ jobId, attempt: attemptNumber, status: record.status }, "duplicate delivery of terminal job, skipping reprocessing");
        return record.result;
      }

      const running = await transitionToRunning(deps.pool, jobId);
      if (!running) {
        const latest = await getJobById(deps.pool, jobId);
        if (latest && (latest.status === "succeeded" || latest.status === "failed")) {
          deps.logger.info({ jobId, attempt: attemptNumber }, "job reached terminal state concurrently, skipping");
          return latest.result;
        }
      }

      const attemptRowId = await recordAttemptStart(deps.pool, jobId, attemptNumber, deps.workerId);
      const startedAt = Date.now();
      deps.logger.info({ jobId, attempt: attemptNumber, transition: "-> running" }, "job attempt started");

      const payload = record.payload as ImageJobPayload;

      try {
        // Fault injection is only ever meaningful for demo-queue jobs --
        // record.is_demo comes from Postgres, not from the payload, so a
        // normal upload cannot opt itself into it.
        await applyFault(payload._fault, attemptNumber, record.is_demo);

        const sourcePath = uploadPathFor(deps.storagePaths, jobId);
        // validateImageBuffer runs inside generateThumbnails, against the
        // actual bytes on disk -- this is the one and only place image
        // format/dimensions are authoritatively checked (see
        // src/jobs/thumbnails.ts). A bad file fails here, permanently.
        const { metadata, thumbnails } = await generateThumbnails(sourcePath, (label) => thumbnailPathFor(deps.storagePaths, jobId, label), deps.imageLimits);

        const result = {
          originalFilename: payload.originalFilename,
          format: metadata.format,
          width: metadata.width,
          height: metadata.height,
          fileSizeBytes: payload.fileSizeBytes,
          thumbnails: thumbnails.map((t) => ({
            label: t.label,
            width: t.width,
            height: t.height,
            fileSizeBytes: t.fileSizeBytes,
            url: `/files/results/${jobId}/${t.label}.jpg`,
          })),
        };

        await transitionToSucceeded(deps.pool, jobId, result, attemptNumber);
        const durationMs = Date.now() - startedAt;
        await recordAttemptEnd(deps.pool, attemptRowId, "succeeded", null);
        metrics.recordCompleted();
        metrics.recordProcessingMs(durationMs);
        deps.logger.info({ jobId, attempt: attemptNumber, transition: "running -> succeeded", durationMs }, "job succeeded");
        return result;
      } catch (err) {
        const durationMs = Date.now() - startedAt;
        const message = err instanceof Error ? err.message : String(err);

        if (err instanceof ValidationError) {
          await transitionToFailed(deps.pool, jobId, message, attemptNumber);
          await recordAttemptEnd(deps.pool, attemptRowId, "failed", message);
          metrics.recordFailed();
          deps.logger.warn({ jobId, attempt: attemptNumber, transition: "running -> failed", durationMs, reason: "validation" }, "job failed permanently: invalid input");
          // Overrides BullMQ's attempts/backoff entirely -- no retry, ever.
          throw new UnrecoverableError(message);
        }

        const isLastAttempt = attemptNumber >= record.max_attempts;
        if (isLastAttempt) {
          await transitionToFailed(deps.pool, jobId, `retries exhausted: ${message}`, attemptNumber);
          await recordAttemptEnd(deps.pool, attemptRowId, "failed", message);
          metrics.recordFailed();
          deps.logger.warn({ jobId, attempt: attemptNumber, transition: "running -> failed", durationMs, reason: "retries_exhausted" }, "job failed: retries exhausted");
        } else {
          await transitionToRetrying(deps.pool, jobId, message, attemptNumber);
          await recordAttemptEnd(deps.pool, attemptRowId, "retrying", message);
          metrics.recordRetried();
          deps.logger.warn({ jobId, attempt: attemptNumber, transition: "running -> retrying", durationMs }, "job attempt failed transiently, will retry");
        }
        // Re-throw a plain error (not UnrecoverableError) so BullMQ applies
        // its normal attempts/backoff bookkeeping and either schedules the
        // next retry or moves the job to its own failed set once exhausted.
        throw err;
      }
    } finally {
      deps.onJobEnd?.();
    }
  };
}
