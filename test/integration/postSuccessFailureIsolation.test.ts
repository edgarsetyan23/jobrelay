// Requires `docker compose up -d`.
//
// worker/processor.ts's success path has three phases (see the comments
// there): do the real work, commit success, then best-effort bookkeeping.
// These tests exist because it's easy to accidentally let phase 3
// (attempt-history / metrics bookkeeping) share a catch block with "this
// job's processing failed" -- and a shared catch block means a history-
// write hiccup that happens to land *after* a real success would delete the
// just-published files and make BullMQ retry work that already completed.
// Similarly, if the success UPDATE itself throws, the only safe assumption
// is "unknown" (Postgres can commit a statement the client never gets an
// acknowledgment for) -- never "it definitely didn't commit, so it's safe
// to delete this attempt's files."
//
// Both tests inject a real Postgres failure with a short-lived trigger
// (created and dropped within the test itself) rather than mocking
// anything, so the assertions are about processor.ts's actual behavior
// against a real database error, not a simulated one.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.js";
import { submitImageJob } from "../../src/api/submitImageJob.js";
import { getJobById, listJobAttempts, type JobRow } from "../../src/db/jobsRepo.js";
import { attemptResultDirFor, attemptThumbnailPathFor } from "../../src/storage/paths.js";
import { createTestHarness, sampleImageBuffer, waitFor, type TestHarness } from "./setup.js";

interface ThumbnailResult {
  label: string;
  url: string;
}
interface JobResult {
  thumbnails: ThumbnailResult[];
}

describe("post-success failures never undo a completed job", () => {
  let harness: TestHarness;
  let app: ReturnType<typeof createApp>;
  let image: Buffer;

  // A fresh harness per test: each test installs a real database trigger,
  // and cleaning it up is simpler and safer when nothing else shares the
  // connection pool it was created through.
  beforeEach(async () => {
    harness = await createTestHarness({ WORKER_CONCURRENCY: 1 });
    app = createApp({
      pool: harness.pool,
      redis: harness.apiRedis,
      dispatcher: harness.dispatcher,
      storagePaths: harness.storagePaths,
      config: harness.config,
      logger: harness.dispatcher.logger,
      publicDir: harness.storagePaths.root,
    });
    image = await sampleImageBuffer();
  });

  afterEach(async () => {
    // Defensive: drop anything a failed assertion might have left behind,
    // even though each test also cleans up its own trigger on the happy
    // path.
    await harness.pool.query("DROP TRIGGER IF EXISTS jr_test_block_job_attempts_update ON job_attempts").catch(() => {});
    await harness.pool.query("DROP FUNCTION IF EXISTS jr_test_block_job_attempts_update()").catch(() => {});
    await harness.pool.query("DROP TRIGGER IF EXISTS jr_test_block_jobs_success_update ON jobs").catch(() => {});
    await harness.pool.query("DROP FUNCTION IF EXISTS jr_test_block_jobs_success_update()").catch(() => {});
    await harness.cleanup();
  });

  it("a history-write failure after successful completion does not delete published files or retry the job", async () => {
    const worker = harness.startWorker("demo");

    // Block every UPDATE on job_attempts for this specific worker -- that's
    // exactly what recordAttemptEnd does. transitionToSucceeded (a write to
    // the *jobs* table) is untouched, so the job itself should still
    // genuinely succeed; only the attempt's own history entry fails to
    // record its outcome.
    await harness.pool.query(`
      CREATE OR REPLACE FUNCTION jr_test_block_job_attempts_update() RETURNS trigger AS $$
      BEGIN
        IF NEW.worker_id = '${worker.workerId}' THEN
          RAISE EXCEPTION 'injected test failure: job_attempts update blocked for worker %', NEW.worker_id;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await harness.pool.query(`
      CREATE TRIGGER jr_test_block_job_attempts_update
      BEFORE UPDATE ON job_attempts
      FOR EACH ROW EXECUTE FUNCTION jr_test_block_job_attempts_update();
    `);

    const { job } = await submitImageJob(
      { pool: harness.pool, dispatcher: harness.dispatcher, storagePaths: harness.storagePaths, maxJobAttempts: harness.config.MAX_JOB_ATTEMPTS },
      { idempotencyKey: randomUUID(), file: { buffer: image, originalname: "history-fail.jpg" }, isDemo: true },
    );

    // The job itself must still succeed -- a history-write failure is not a
    // processing failure.
    await waitFor(async () => (await getJobById(harness.pool, job.id))?.status === "succeeded", 10_000);

    const succeededJob = (await getJobById(harness.pool, job.id)) as JobRow;
    expect(succeededJob.status).toBe("succeeded");
    expect(succeededJob.result_attempt_token).toBeTruthy();
    const result = succeededJob.result as JobResult;
    expect(result.thumbnails).toHaveLength(3);

    // "Successful jobs retain working downloads": fetch every thumbnail
    // through the real HTTP endpoint, not just check the file exists.
    for (const t of result.thumbnails) {
      const res = await request(app).get(t.url);
      expect(res.status).toBe(200);
    }
    const onDisk = await readFile(attemptThumbnailPathFor(harness.storagePaths, job.id, succeededJob.result_attempt_token!, "small"));
    expect(onDisk.byteLength).toBeGreaterThan(0);

    // The attempt's own history row never got its "succeeded" end-state
    // written (the trigger blocked it every time) -- it's stuck at
    // whatever recordAttemptStart set it to. That's the honest, expected
    // shape of "the process's own bookkeeping failed," not a bug -- the
    // critical thing is what it must NOT be: 'failed' or 'retrying' would
    // mean the history-write failure got treated as a processing failure.
    const attempts = await listJobAttempts(harness.pool, job.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe("running");

    // And exactly one attempt ever ran -- no retry was triggered by the
    // bookkeeping failure.
    expect(succeededJob.attempts).toBe(1);
  }, 20_000);

  it("an uncertain success-update outcome preserves the attempt's files instead of assuming rollback, and the job still recovers", async () => {
    const { job } = await submitImageJob(
      { pool: harness.pool, dispatcher: harness.dispatcher, storagePaths: harness.storagePaths, maxJobAttempts: harness.config.MAX_JOB_ATTEMPTS },
      { idempotencyKey: randomUUID(), file: { buffer: image, originalname: "uncertain.jpg" }, isDemo: true },
    );

    // Block only this specific job's transition to 'succeeded'. A trigger
    // that RAISEs always rolls the statement back -- so from Postgres's
    // point of view this genuinely never commits -- but the point under
    // test is that processor.ts doesn't get to assume that from the throw
    // alone: it must re-check the database rather than guessing, and this
    // is the "checked, and it's still not terminal" branch of that logic.
    await harness.pool.query(`
      CREATE OR REPLACE FUNCTION jr_test_block_jobs_success_update() RETURNS trigger AS $$
      BEGIN
        IF NEW.id = '${job.id}' AND NEW.status = 'succeeded' THEN
          RAISE EXCEPTION 'injected test failure: success update blocked for job %', NEW.id;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await harness.pool.query(`
      CREATE TRIGGER jr_test_block_jobs_success_update
      BEFORE UPDATE ON jobs
      FOR EACH ROW EXECUTE FUNCTION jr_test_block_jobs_success_update();
    `);

    // A wide backoff window so there's a comfortable gap between the first
    // (blocked) attempt and BullMQ's retry -- enough time to assert on the
    // preserved-but-not-yet-recovered state without racing the next attempt.
    harness.startWorker("demo", { BACKOFF_BASE_MS: 4000, BACKOFF_MAX_MS: 4000, BACKOFF_JITTER: 0 });

    await waitFor(async () => {
      const attempts = await listJobAttempts(harness.pool, job.id);
      return attempts.some((a) => typeof a.error === "string" && a.error.includes("success update outcome uncertain"));
    }, 10_000);

    // At this point the first attempt's write was blocked and it re-queried
    // Postgres, found the row still non-terminal, and (per the code under
    // test) chose not to guess. Capture that attempt's token before
    // anything else can change it.
    const midway = (await getJobById(harness.pool, job.id)) as JobRow;
    expect(midway.status).not.toBe("succeeded");
    expect(midway.status).not.toBe("failed");
    const blockedToken = midway.running_token;
    expect(blockedToken).toBeTruthy();

    // The critical assertion: this attempt's files were never discarded,
    // even though its own success update threw.
    expect(existsSync(attemptResultDirFor(harness.storagePaths, job.id, blockedToken!))).toBe(true);
    const preserved = await readFile(attemptThumbnailPathFor(harness.storagePaths, job.id, blockedToken!, "small"));
    expect(preserved.byteLength).toBeGreaterThan(0);

    // Now let the job actually recover: remove the fault and let BullMQ's
    // already-scheduled retry (or the next one) go through cleanly.
    await harness.pool.query("DROP TRIGGER IF EXISTS jr_test_block_jobs_success_update ON jobs");
    await harness.pool.query("DROP FUNCTION IF EXISTS jr_test_block_jobs_success_update()");

    await waitFor(async () => (await getJobById(harness.pool, job.id))?.status === "succeeded", 15_000);
    const succeededJob = (await getJobById(harness.pool, job.id)) as JobRow;
    const result = succeededJob.result as JobResult;
    expect(result.thumbnails).toHaveLength(3);

    // "Successful jobs retain working downloads" -- through the real HTTP
    // endpoint, resolved via whichever attempt actually ended up owning
    // the result.
    for (const t of result.thumbnails) {
      const res = await request(app).get(t.url);
      expect(res.status).toBe(200);
    }
  }, 25_000);
});
