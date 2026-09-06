// The actual per-job work, independent of BullMQ's Job wrapper so it's easy
// to reason about and unit-test the transition logic. See docs/ARCHITECTURE.md
// "Life of a job" for the full state diagram this function implements.
import { randomUUID } from "node:crypto";
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
import { attemptThumbnailPathFor, discardAttemptResult, promoteAttemptResult, uploadPathFor, type StoragePaths } from "../storage/paths.js";

export interface ImageJobPayload {
  /** Display-only, sanitized client-supplied filename. Never used to build a filesystem path. */
  originalFilename: string;
  fileSizeBytes: number;
  /** sha256 of the uploaded bytes -- part of the idempotency fingerprint, see submitImageJob.ts. */
  contentSha256: string;
  /** Only ever honored for jobs on the demo queue -- see the header comment in src/faults/inject.ts. */
  _fault?: FaultSpec;
}

export interface ProcessorDeps {
  pool: Pool;
  logger: Logger;
  workerId: string;
  storagePaths: StoragePaths;
  imageLimits: ImageLimits;
  /** Called right before/after processing so the worker can heartbeat its busy/idle status against the set of jobs it actually has in flight. */
  onJobStart?: (jobId: string) => void;
  onJobEnd?: (jobId: string) => void;
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

      // A fencing token unique to *this* attempt (not BullMQ's attemptsMade,
      // which can repeat: a lock-expiry redelivery to a new worker reuses
      // the same attempt number the still-alive old worker is holding).
      // transitionToRunning stamps it fresh; every finalize below must
      // present it back, so whichever attempt most recently claimed
      // 'running' is the only one allowed to decide the outcome -- see
      // docs/FAILURE_SCENARIOS.md "Worker crash" and 003_attempt_ownership.sql.
      const runningToken = randomUUID();
      const running = await transitionToRunning(deps.pool, jobId, runningToken);
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
        //
        // Every attempt writes into its own directory, keyed by its own
        // runningToken -- never the shared, publicly-served location. A
        // stale-but-still-alive attempt (see docs/FAILURE_SCENARIOS.md
        // "Stale attempt") can keep writing here for as long as it likes
        // without any chance of corrupting or racing the actual winner's
        // files; only transitionToSucceeded winning below promotes a
        // directory to where /files/results/:jobId/:label.jpg serves from.
        const { metadata, thumbnails } = await generateThumbnails(
          sourcePath,
          (label) => attemptThumbnailPathFor(deps.storagePaths, jobId, runningToken, label),
          deps.imageLimits,
        );

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

        // The database decides the winner first -- only once this
        // ownership-checked write actually succeeds do this attempt's files
        // get promoted to the location its own `result.thumbnails[].url`
        // values point at. Deciding filesystem placement before the DB
        // write is confirmed would risk publishing a loser's files (or
        // clobbering a genuine winner's) if two attempts raced each other
        // to promote at the same time.
        const succeeded = await transitionToSucceeded(deps.pool, jobId, result, attemptNumber, runningToken);
        const durationMs = Date.now() - startedAt;
        // This attempt's own history entry reflects what actually happened
        // to it, independent of whether it won the job-level race below.
        await recordAttemptEnd(deps.pool, attemptRowId, "succeeded", null);
        if (!succeeded) {
          // Lost the fencing-token race: a newer attempt (our own
          // replacement, spun up after BullMQ decided our lock had expired)
          // already claimed 'running' again and will finalize the job
          // itself. Don't overwrite whatever it eventually writes -- and
          // clean up the thumbnails we generated, since they'll never be
          // served from anywhere.
          await discardAttemptResult(deps.storagePaths, jobId, runningToken);
          const latest = await getJobById(deps.pool, jobId);
          deps.logger.warn({ jobId, attempt: attemptNumber }, "completed work but lost attempt-ownership race; discarding this attempt's files and job-level result");
          return latest?.result ?? result;
        }
        await promoteAttemptResult(deps.storagePaths, jobId, runningToken);
        metrics.recordCompleted();
        metrics.recordProcessingMs(durationMs);
        deps.logger.info({ jobId, attempt: attemptNumber, transition: "running -> succeeded", durationMs }, "job succeeded");
        return result;
      } catch (err) {
        const durationMs = Date.now() - startedAt;
        const message = err instanceof Error ? err.message : String(err);
        // No failure path ever publishes a result, so this attempt's output
        // directory (typically empty -- both the fault hook and
        // validateImageBuffer throw before any thumbnail file is written,
        // but a failure partway through the resize loop could leave a
        // partial one behind) never should either. Safe even if nothing was
        // ever written.
        await discardAttemptResult(deps.storagePaths, jobId, runningToken);

        if (err instanceof ValidationError) {
          const failed = await transitionToFailed(deps.pool, jobId, message, attemptNumber, runningToken);
          await recordAttemptEnd(deps.pool, attemptRowId, "failed", message);
          if (!failed) {
            deps.logger.warn({ jobId, attempt: attemptNumber }, "validation failed but lost attempt-ownership race; a newer attempt now owns this job");
          } else {
            metrics.recordFailed();
            deps.logger.warn({ jobId, attempt: attemptNumber, transition: "running -> failed", durationMs, reason: "validation" }, "job failed permanently: invalid input");
          }
          // Overrides BullMQ's attempts/backoff entirely -- no retry, ever.
          throw new UnrecoverableError(message);
        }

        const isLastAttempt = attemptNumber >= record.max_attempts;
        if (isLastAttempt) {
          const failed = await transitionToFailed(deps.pool, jobId, `retries exhausted: ${message}`, attemptNumber, runningToken);
          await recordAttemptEnd(deps.pool, attemptRowId, "failed", message);
          if (!failed) {
            deps.logger.warn({ jobId, attempt: attemptNumber }, "retries exhausted but lost attempt-ownership race; a newer attempt now owns this job");
          } else {
            metrics.recordFailed();
            deps.logger.warn({ jobId, attempt: attemptNumber, transition: "running -> failed", durationMs, reason: "retries_exhausted" }, "job failed: retries exhausted");
          }
        } else {
          const retrying = await transitionToRetrying(deps.pool, jobId, message, attemptNumber, runningToken);
          await recordAttemptEnd(deps.pool, attemptRowId, "retrying", message);
          if (!retrying) {
            deps.logger.warn({ jobId, attempt: attemptNumber }, "transient failure but lost attempt-ownership race; a newer attempt now owns this job");
          } else {
            metrics.recordRetried();
            deps.logger.warn({ jobId, attempt: attemptNumber, transition: "running -> retrying", durationMs }, "job attempt failed transiently, will retry");
          }
        }
        // Re-throw a plain error (not UnrecoverableError) so BullMQ applies
        // its normal attempts/backoff bookkeeping and either schedules the
        // next retry or moves the job to its own failed set once exhausted.
        throw err;
      }
    } finally {
      deps.onJobEnd?.(jobId);
    }
  };
}
