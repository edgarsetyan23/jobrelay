// Requires `docker compose up -d`.
//
// Complements attemptOwnership.test.ts (which proves the *database* row
// can't be finalized twice) by proving the *filesystem* side of the same
// race is safe: every attempt writes its thumbnails into its own directory,
// and a stale-but-still-alive attempt that keeps writing after its
// replacement has already published a result must never be able to touch
// -- let alone corrupt -- the files a real visitor is downloading.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.js";
import { submitImageJob } from "../../src/api/submitImageJob.js";
import { getJobById, type JobRow } from "../../src/db/jobsRepo.js";
import { attemptResultDirFor, thumbnailPathFor } from "../../src/storage/paths.js";
import { createTestHarness, sampleImageBuffer, waitFor, type TestHarness } from "./setup.js";

interface ThumbnailResult {
  label: string;
  url: string;
}
interface JobResult {
  thumbnails: ThumbnailResult[];
}

describe("attempt isolation for thumbnail outputs", () => {
  let harness: TestHarness;
  let app: ReturnType<typeof createApp>;
  let image: Buffer;

  beforeAll(async () => {
    harness = await createTestHarness({
      LOCK_DURATION_MS: 500,
      STALLED_INTERVAL_MS: 200,
      MAX_STALLED_COUNT: 3,
      WORKER_CONCURRENCY: 1,
    });
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

  afterAll(async () => {
    await harness.cleanup();
  });

  it("keeps the winner's published downloads byte-for-byte intact while a stale attempt keeps writing to its own directory", async () => {
    // `slow` with no `onlyOnAttempt` makes both the stale attempt and its
    // recovery sleep through the same delay -- see attemptOwnership.test.ts
    // for why this is what actually creates a genuine overlapping-attempt
    // window rather than a simple "dead worker" case.
    const { job } = await submitImageJob(
      { pool: harness.pool, dispatcher: harness.dispatcher, storagePaths: harness.storagePaths, maxJobAttempts: harness.config.MAX_JOB_ATTEMPTS },
      {
        idempotencyKey: randomUUID(),
        file: { buffer: image, originalname: "isolation.jpg" },
        isDemo: true,
        fault: { mode: "slow", delayMs: 1500 },
      },
    );

    const { worker: staleWorker, connection: staleConnection } = harness.startWorker("demo");
    await waitFor(async () => (await getJobById(harness.pool, job.id))?.status === "running");
    const staleToken = (await getJobById(harness.pool, job.id))?.running_token;
    expect(staleToken).toBeTruthy();

    // "Crash" without a graceful close: the stale worker's own in-flight
    // `slow` setTimeout keeps running to completion regardless.
    staleConnection.disconnect();
    void staleWorker.close(true).catch(() => {});

    harness.startWorker("demo");
    await waitFor(async () => (await getJobById(harness.pool, job.id))?.status === "succeeded", 10_000);

    const succeededJob = (await getJobById(harness.pool, job.id)) as JobRow;
    const result = succeededJob.result as JobResult;
    expect(result.thumbnails).toHaveLength(3);

    // Confirm every thumbnail is actually downloadable right after the
    // winner published its result, and snapshot the bytes on disk at the
    // job's canonical (publicly-served) location.
    const winningBytes = new Map<string, Buffer>();
    for (const t of result.thumbnails) {
      const res = await request(app).get(t.url);
      expect(res.status).toBe(200);
      winningBytes.set(t.label, await readFile(thumbnailPathFor(harness.storagePaths, job.id, t.label)));
    }

    // Give the stale attempt's own setTimeout time to resolve and attempt
    // its own (losing) writes and finalize call.
    await new Promise((resolve) => setTimeout(resolve, 1700));

    // The published files must be byte-for-byte unchanged, and still
    // downloadable through the exact same URLs -- the stale attempt spent
    // that whole window writing into its own isolated directory, never the
    // canonical one.
    for (const t of result.thumbnails) {
      const res = await request(app).get(t.url);
      expect(res.status).toBe(200);
      const onDiskNow = await readFile(thumbnailPathFor(harness.storagePaths, job.id, t.label));
      expect(onDiskNow.equals(winningBytes.get(t.label)!)).toBe(true);
    }

    // And the losing attempt's own directory must have been cleaned up
    // (discardAttemptResult), not left behind as a disk leak.
    expect(existsSync(attemptResultDirFor(harness.storagePaths, job.id, staleToken!))).toBe(false);
  }, 20_000);
});
