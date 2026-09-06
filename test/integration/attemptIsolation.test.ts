// Requires `docker compose up -d`.
//
// Complements attemptOwnership.test.ts (which proves the *database* row
// can't be finalized twice) by proving the *filesystem* side of the same
// race is safe: every attempt writes its thumbnails into its own directory
// and stays there permanently (see storage/paths.ts "Attempt isolation");
// the download endpoint resolves which directory to serve by looking up
// `result_attempt_token` in Postgres on every request. A stale-but-still-
// alive attempt that keeps writing after its replacement has already
// published a result must never be able to touch -- let alone corrupt --
// the files a real visitor is downloading.
//
// Uses a manually-controlled gate (`beforeSuccessCommit`), not a timed
// `slow` fault, to hold the stale attempt open until the winner has
// *already* finished: two independent delays only ever *tend* to produce
// that ordering, they don't guarantee it.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.js";
import { submitImageJob } from "../../src/api/submitImageJob.js";
import { getJobById, type JobRow } from "../../src/db/jobsRepo.js";
import { attemptResultDirFor, attemptThumbnailPathFor } from "../../src/storage/paths.js";
import { createGate, createTestHarness, sampleImageBuffer, waitFor, type TestHarness } from "./setup.js";

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

  it("keeps the winner's published downloads byte-for-byte intact while a stale attempt is released to keep writing after the winner has already finished", async () => {
    const { job } = await submitImageJob(
      { pool: harness.pool, dispatcher: harness.dispatcher, storagePaths: harness.storagePaths, maxJobAttempts: harness.config.MAX_JOB_ATTEMPTS },
      { idempotencyKey: randomUUID(), file: { buffer: image, originalname: "isolation.jpg" }, isDemo: true },
    );

    // Held closed until step 4 below -- see attemptOwnership.test.ts for why
    // a gate, not a timed fault, is what actually guarantees this ordering.
    const staleGate = createGate();
    const { worker: staleWorker, connection: staleConnection } = harness.startWorker("demo", {}, { beforeSuccessCommit: staleGate.wait });

    // 1. The stale attempt fully generates and closes its thumbnails (into
    //    its own directory) and blocks right before its DB commit.
    await waitFor(async () => (await getJobById(harness.pool, job.id))?.status === "running");
    const staleToken = (await getJobById(harness.pool, job.id))?.running_token;
    expect(staleToken).toBeTruthy();

    // 2. "Crash" it without a graceful close -- its parked call stack is
    //    unaffected; it's still very much "alive" from the JS runtime's
    //    point of view, just no longer renewing its BullMQ lock.
    staleConnection.disconnect();
    void staleWorker.close(true).catch(() => {});

    // 3. The recovery worker claims the job once it's detected as stalled,
    //    and completes it -- this is "the winner has already finished."
    harness.startWorker("demo");
    await waitFor(async () => (await getJobById(harness.pool, job.id))?.status === "succeeded", 10_000);

    const succeededJob = (await getJobById(harness.pool, job.id)) as JobRow;
    const result = succeededJob.result as JobResult;
    expect(result.thumbnails).toHaveLength(3);
    expect(succeededJob.result_attempt_token).toBeTruthy();
    expect(succeededJob.result_attempt_token).not.toBe(staleToken);

    // Confirm every thumbnail is downloadable right now, and snapshot the
    // bytes at the exact attempt directory the DB says is authoritative.
    const winningBytes = new Map<string, Buffer>();
    for (const t of result.thumbnails) {
      const res = await request(app).get(t.url);
      expect(res.status).toBe(200);
      const onDisk = attemptThumbnailPathFor(harness.storagePaths, job.id, succeededJob.result_attempt_token!, t.label);
      winningBytes.set(t.label, await readFile(onDisk));
    }

    // 4. Only now release the stale attempt. Its transitionToSucceeded call
    //    is guaranteed -- not merely likely -- to land after the winner's,
    //    lose the ownership race, and discard its own directory.
    staleGate.release();
    await waitFor(() => !existsSync(attemptResultDirFor(harness.storagePaths, job.id, staleToken!)));

    // The published files must be byte-for-byte unchanged, and still
    // downloadable through the exact same URLs -- the stale attempt's own
    // files lived the whole time in a directory nothing ever pointed at.
    for (const t of result.thumbnails) {
      const res = await request(app).get(t.url);
      expect(res.status).toBe(200);
      const onDiskNow = await readFile(attemptThumbnailPathFor(harness.storagePaths, job.id, succeededJob.result_attempt_token!, t.label));
      expect(onDiskNow.equals(winningBytes.get(t.label)!)).toBe(true);
    }
  }, 20_000);
});
