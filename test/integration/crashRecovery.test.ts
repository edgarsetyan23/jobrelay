// Requires `docker compose up -d`.
//
// Simulates an ungraceful worker crash -- the same mechanism behind the
// interactive demo's "Stop this worker" button, minus the actual OS process
// (see demoPanel.test.ts for that end-to-end version). We do NOT call
// worker.close() (which would cleanly release the job lock). Instead we yank
// the underlying Redis connection out from under a worker mid-job, exactly
// like `kill -9` would -- the process stops renewing its lock and never
// tells BullMQ it's done.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { submitImageJob } from "../../src/api/submitImageJob.js";
import { getJobById, listJobAttempts } from "../../src/db/jobsRepo.js";
import { createTestHarness, sampleImageBuffer, waitFor, type TestHarness } from "./setup.js";

describe("worker crash + stalled-job recovery", () => {
  let harness: TestHarness;
  let image: Buffer;

  beforeAll(async () => {
    harness = await createTestHarness({
      LOCK_DURATION_MS: 800,
      STALLED_INTERVAL_MS: 300,
      MAX_STALLED_COUNT: 3,
      WORKER_CONCURRENCY: 1,
    });
    image = await sampleImageBuffer();
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  it("recovers a job whose worker crashed mid-processing and completes it exactly once", async () => {
    // Attempt 1 sleeps long enough for us to "crash" the worker and for the
    // lock to expire; attempt 2+ (the recovering worker) completes normally.
    const { job } = await submitImageJob(
      { pool: harness.pool, dispatcher: harness.dispatcher, storagePaths: harness.storagePaths, maxJobAttempts: harness.config.MAX_JOB_ATTEMPTS },
      {
        idempotencyKey: randomUUID(),
        file: { buffer: image, originalname: "slow.jpg" },
        isDemo: true,
        fault: { mode: "slow", delayMs: 1800, onlyOnAttempt: 1 },
      },
    );

    const { worker: crashingWorker, connection: crashingConnection } = harness.startWorker("demo");

    await waitFor(async () => (await getJobById(harness.pool, job.id))?.status === "running");

    // Simulate `kill -9`: sever the connection without a graceful close. The
    // worker never renews its lock or reports completion after this.
    crashingConnection.disconnect();
    void crashingWorker.close(true).catch(() => {});

    // A second, independent worker instance -- standing in for "the queue
    // hands the job to another worker after detecting the failure". Its own
    // stalled-job check (stalledInterval) is what notices the abandoned lock.
    harness.startWorker("demo");

    await waitFor(async () => (await getJobById(harness.pool, job.id))?.status === "succeeded", 15_000);

    const final = await getJobById(harness.pool, job.id);
    expect(final?.status).toBe("succeeded");
    expect(final?.result).toBeTruthy();

    // Give the crashed worker's already-in-flight setTimeout a moment to
    // resolve and attempt its own (stale) completion -- it must not corrupt
    // the already-succeeded row.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const afterStaleCompletion = await getJobById(harness.pool, job.id);
    expect(afterStaleCompletion?.status).toBe("succeeded");
    expect(afterStaleCompletion?.result).toEqual(final?.result);

    const attempts = await listJobAttempts(harness.pool, job.id);
    expect(attempts.length).toBeGreaterThanOrEqual(2); // the crashed attempt + at least one recovery attempt
  });
});
