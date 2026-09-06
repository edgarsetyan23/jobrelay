// Requires `docker compose up -d`.
//
// JobRelay assumes at-least-once execution end to end (never exactly-once).
// This test exercises both layers that make duplicate delivery safe:
//   1. BullMQ itself: re-adding a job with the same jobId while it still
//      exists in the queue is a documented no-op (no second execution).
//   2. Our own guard in worker/processor.ts: even if a duplicate *did* reach
//      the processor (e.g. the job had already been trimmed from Redis),
//      the Postgres-side terminal-state check short-circuits it.
import { randomUUID } from "node:crypto";
import type { Job } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { submitImageJob } from "../../src/api/submitImageJob.js";
import { getJobById, listJobAttempts } from "../../src/db/jobsRepo.js";
import { makeProcessor } from "../../src/worker/processor.js";
import { logger } from "../../src/logger.js";
import type { JobQueueData } from "../../src/queue/queue.js";
import { createTestHarness, sampleImageBuffer, waitFor, type TestHarness } from "./setup.js";

describe("duplicate delivery", () => {
  let harness: TestHarness;
  let image: Buffer;

  beforeAll(async () => {
    harness = await createTestHarness();
    harness.startWorker("main");
    image = await sampleImageBuffer();
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  it("re-adding the same jobId while the job is still queued/active does not create a second execution", async () => {
    const { job } = await submitImageJob(
      { pool: harness.pool, dispatcher: harness.dispatcher, storagePaths: harness.storagePaths, maxJobAttempts: harness.config.MAX_JOB_ATTEMPTS },
      { idempotencyKey: randomUUID(), file: { buffer: image, originalname: "a.jpg" }, isDemo: false },
    );

    // Publish a second time in a row before it's had a chance to complete --
    // BullMQ dedupes by jobId (job.id is used verbatim as the BullMQ jobId).
    await harness.queues.main.add("thumbnail", { jobId: job.id, jobType: "thumbnail" }, { jobId: job.id });

    await waitFor(async () => (await getJobById(harness.pool, job.id))?.status === "succeeded");

    const attempts = await listJobAttempts(harness.pool, job.id);
    expect(attempts).toHaveLength(1); // exactly one execution happened
  });

  it("calling the processor again on an already-succeeded job returns the stored result without reprocessing", async () => {
    const { job } = await submitImageJob(
      { pool: harness.pool, dispatcher: harness.dispatcher, storagePaths: harness.storagePaths, maxJobAttempts: harness.config.MAX_JOB_ATTEMPTS },
      { idempotencyKey: randomUUID(), file: { buffer: image, originalname: "b.jpg" }, isDemo: false },
    );
    await waitFor(async () => (await getJobById(harness.pool, job.id))?.status === "succeeded");

    const afterFirstRun = await getJobById(harness.pool, job.id);
    const attemptsAfterFirstRun = await listJobAttempts(harness.pool, job.id);

    // Directly invoke the processor a second time, as if a duplicate BullMQ
    // delivery landed after the job had already completed and been trimmed
    // from Redis. A minimal fake Job is enough -- the processor only reads
    // job.data and job.attemptsMade.
    const processor = makeProcessor({
      pool: harness.pool,
      logger,
      workerId: "duplicate-delivery-test-worker",
      storagePaths: harness.storagePaths,
      imageLimits: { maxUploadBytes: harness.config.MAX_UPLOAD_BYTES, maxDimensionPx: harness.config.MAX_IMAGE_DIMENSION_PX, maxPixels: harness.config.MAX_IMAGE_PIXELS },
    });
    const fakeDuplicateJob = { data: { jobId: job.id, jobType: "thumbnail" }, attemptsMade: 0 } as Job<JobQueueData>;
    const duplicateResult = await processor(fakeDuplicateJob);

    expect(duplicateResult).toEqual(afterFirstRun?.result);

    const afterDuplicateRun = await getJobById(harness.pool, job.id);
    expect(afterDuplicateRun?.result).toEqual(afterFirstRun?.result);
    expect(afterDuplicateRun?.updated_at).toEqual(afterFirstRun?.updated_at); // row was not touched again

    const attemptsAfterDuplicateRun = await listJobAttempts(harness.pool, job.id);
    expect(attemptsAfterDuplicateRun).toHaveLength(attemptsAfterFirstRun.length); // no new attempt row was recorded
  });
});
