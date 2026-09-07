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
  type JobRow,
} from "../db/jobsRepo.js";
import { generateThumbnails, ValidationError, type ImageLimits } from "../jobs/thumbnails.js";
import { applyFault, type FaultSpec } from "../faults/inject.js";
import { metrics } from "../metrics/metrics.js";
import type { Logger } from "../logger.js";
import type { JobQueueData } from "../queue/queue.js";
import { attemptThumbnailPathFor, discardAttemptResult, uploadPathFor, type StoragePaths } from "../storage/paths.js";

export interface ImageJobPayload {
  /** Display-only, sanitized client-supplied filename. Never used to build a filesystem path. */
  originalFilename: string;
  fileSizeBytes: number;
  /** sha256 of the uploaded bytes -- part of the idempotency fingerprint, see submitImageJob.ts. */
  contentSha256: string;
  /** Only ever honored for jobs on the demo queue -- see the header comment in src/faults/inject.ts. */
  _fault?: FaultSpec;
}

interface ImageJobResult {
  originalFilename: string;
  format: string;
  width: number;
  height: number;
  fileSizeBytes: number;
  thumbnails: Array<{ label: string; width: number; height: number; fileSizeBytes: number; url: string }>;
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
  /**
   * Test-only seams -- never set by worker.ts in production. Real crash
   * timing can't be pinned to an exact line by racing two independent
   * delays (that only ever *tends* to produce a given ordering); these let
   * a test deterministically hold an attempt open at the two moments that
   * matter most for correctness, so it can assert on state at that exact
   * point before choosing whether the attempt ever proceeds:
   *
   * - `beforeSuccessCommit`: this attempt's thumbnails are fully generated,
   *   written, and closed, but `transitionToSucceeded` has not yet been
   *   called. A test never releasing this simulates "the process is gone
   *   the instant before the success update" -- see
   *   test/integration/successCommitCrash.test.ts.
   * - `afterSuccessCommit`: `transitionToSucceeded` has just resolved
   *   (whichever way). A test never releasing this simulates "the process
   *   is gone the instant after the success update," while everything a
   *   client could observe (the DB row, the winning files) is already
   *   durably in place.
   */
  beforeSuccessCommit?: () => Promise<void> | void;
  afterSuccessCommit?: () => Promise<void> | void;
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

      // ---- Phase 1: do the actual work -------------------------------
      // A failure anywhere in here is a genuine processing failure: no
      // success has been attempted yet, so this attempt's output directory
      // (typically empty -- both the fault hook and validateImageBuffer
      // throw before any thumbnail file is written, but a failure partway
      // through the resize loop could leave a partial one behind) is never
      // a published result. Always safe to discard.
      let result: ImageJobResult;
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
        // Every attempt writes into, and stays in, its own directory, keyed
        // by its own runningToken -- never a shared, job-scoped location.
        // A stale-but-still-alive attempt (see docs/FAILURE_SCENARIOS.md
        // "Stale attempt") can keep writing here for as long as it likes
        // without any chance of corrupting or racing the actual winner's
        // files: there is nothing to race, because nothing ever moves.
        // Whichever attempt wins the ownership check below has its files
        // served directly from here -- see the download endpoint,
        // api/routes/files.ts, which looks up `result_attempt_token` in
        // Postgres to find this exact directory.
        const { metadata, thumbnails } = await generateThumbnails(
          sourcePath,
          (label) => attemptThumbnailPathFor(deps.storagePaths, jobId, runningToken, label),
          deps.imageLimits,
        );

        result = {
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
      } catch (err) {
        const durationMs = Date.now() - startedAt;
        const message = err instanceof Error ? err.message : String(err);
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

      // ---- Phase 2: commit success ------------------------------------
      // From here on, this attempt's files are either genuinely published
      // or in a state only a future attempt -- never a deletion here --
      // should resolve. A failure in this phase is NEVER treated as "this
      // job's processing failed": the real work already happened.
      //
      // Every file is fully written and its handle closed by the time
      // generateThumbnails above resolved (sharp's .toFile() only resolves
      // once its write stream has finished and closed), so there is
      // nothing left to flush here.
      await deps.beforeSuccessCommit?.();

      let succeededRow: JobRow | undefined;
      try {
        // The database decides the winner, and permanently: this attempt's
        // directory is never moved anywhere afterward. If this write
        // succeeds, `result_attempt_token` (set by transitionToSucceeded
        // itself, in the same statement) becomes the durable pointer to
        // this exact directory -- that's what the download endpoint reads.
        succeededRow = await transitionToSucceeded(deps.pool, jobId, result, attemptNumber, runningToken);
      } catch (commitErr) {
        // The UPDATE call itself didn't complete cleanly -- e.g. a
        // connection reset while the response was in flight. That does
        // NOT mean it never reached Postgres: the statement can commit
        // server-side even though the client never sees the
        // acknowledgment. Ask the database what actually happened instead
        // of assuming the throw means "rolled back."
        const latest = await getJobById(deps.pool, jobId).catch(() => undefined);

        if (latest?.status === "succeeded" && latest.result_attempt_token === runningToken) {
          // It committed; only the acknowledgment was lost. This attempt
          // is confirmed to have won -- proceed exactly as a normal
          // success below, just with a note that the write's own response
          // never arrived.
          deps.logger.warn({ jobId, attempt: attemptNumber, err: commitErr }, "success update's acknowledgment was lost, but Postgres confirms this attempt's write committed");
          succeededRow = latest;
        } else if (latest && (latest.status === "succeeded" || latest.status === "failed")) {
          // A different attempt is CONFIRMED to already own this job's
          // outcome -- ours definitively did not land. Safe to discard:
          // nothing will ever point at this directory.
          await discardAttemptResult(deps.storagePaths, jobId, runningToken);
          await recordAttemptEnd(deps.pool, attemptRowId, "succeeded", null).catch((err) =>
            deps.logger.warn({ jobId, attempt: attemptNumber, err }, "recording this attempt's own history failed after a confirmed ownership loss"),
          );
          deps.logger.warn({ jobId, attempt: attemptNumber, err: commitErr }, "success update failed and a different attempt already owns this job; discarding this attempt's files");
          return latest.result;
        } else {
          // Genuinely can't tell whether the write landed -- the row is
          // still non-terminal (or even the re-check itself failed). A
          // false "leave an orphaned directory around" is only a disk-
          // hygiene cost the retention sweep eventually cleans up; a false
          // "delete the real published result" is data loss. Never guess
          // toward deletion: leave this attempt's files exactly where they
          // are and let BullMQ's normal retry bookkeeping take over -- if
          // this attempt actually did win, the next redelivery's
          // duplicate-delivery guard at the top of processJob will
          // discover that from Postgres on its own, without ever touching
          // this directory again.
          const message = commitErr instanceof Error ? commitErr.message : String(commitErr);
          await recordAttemptEnd(deps.pool, attemptRowId, "retrying", `success update outcome uncertain: ${message}`).catch((err) =>
            deps.logger.warn({ jobId, attempt: attemptNumber, err }, "recording this attempt's own history failed after an uncertain success update"),
          );
          deps.logger.error({ jobId, attempt: attemptNumber, err: commitErr }, "success update failed with an uncertain outcome; preserving this attempt's files rather than guessing");
          throw commitErr;
        }
      }
      await deps.afterSuccessCommit?.();

      if (!succeededRow) {
        // Lost the fencing-token race with an ordinary (non-throwing) 0-row
        // update: a newer attempt (our own replacement, spun up after
        // BullMQ decided our lock had expired) already claimed 'running'
        // again and will finalize the job itself. Don't overwrite whatever
        // it eventually writes -- and clean up the thumbnails we
        // generated, since nothing will ever point at this directory now.
        await discardAttemptResult(deps.storagePaths, jobId, runningToken);
        const latest = await getJobById(deps.pool, jobId);
        await recordAttemptEnd(deps.pool, attemptRowId, "succeeded", null).catch((err) =>
          deps.logger.warn({ jobId, attempt: attemptNumber, err }, "recording this attempt's own history failed after a lost ownership race"),
        );
        deps.logger.warn({ jobId, attempt: attemptNumber }, "completed work but lost attempt-ownership race; discarding this attempt's files and job-level result");
        return latest?.result ?? result;
      }

      // ---- Phase 3: post-success bookkeeping --------------------------
      // The job is CONFIRMED succeeded, with this attempt's files as the
      // published result (nothing to move -- that directory simply *is*
      // the result now, permanently, until retention purges the whole
      // job). Everything left is best-effort: a failure recording history
      // or metrics must never undo the success, trigger a retry of
      // already-completed work, or delete the files that are now the
      // job's actual, durable result.
      try {
        const durationMs = Date.now() - startedAt;
        await recordAttemptEnd(deps.pool, attemptRowId, "succeeded", null);
        metrics.recordCompleted();
        metrics.recordProcessingMs(durationMs);
        deps.logger.info({ jobId, attempt: attemptNumber, transition: "running -> succeeded", durationMs }, "job succeeded");
      } catch (bookkeepingErr) {
        deps.logger.warn(
          { jobId, attempt: attemptNumber, err: bookkeepingErr },
          "post-success bookkeeping (attempt history or metrics) failed; the job itself succeeded and its published files are unaffected",
        );
      }
      return result;
    } finally {
      deps.onJobEnd?.(jobId);
    }
  };
}
