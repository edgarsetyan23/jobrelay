// Requires `docker compose up -d`.
//
// The success path makes exactly one durability promise: a job's files are
// fully generated, written, and closed *before* the ownership-checked
// database update that marks it 'succeeded' ever runs (see
// worker/processor.ts). These two tests pin a simulated crash to the two
// instants on either side of that update -- immediately before it, and
// immediately after it -- using the `beforeSuccessCommit` /
// `afterSuccessCommit` test-only seams on ProcessorDeps rather than a timed
// delay, since only an explicit hold-point can guarantee the crash lands
// on an exact line rather than somewhere near it.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { submitImageJob } from "../../src/api/submitImageJob.js";
import { getJobById, listJobAttempts, type JobRow } from "../../src/db/jobsRepo.js";
import { attemptResultDirFor, attemptThumbnailPathFor } from "../../src/storage/paths.js";
import { sweepOnce } from "../../src/cleanup/retention.js";
import { createGate, createTestHarness, sampleImageBuffer, waitFor, type TestHarness } from "./setup.js";

interface ThumbnailResult {
  label: string;
  url: string;
}
interface JobResult {
  thumbnails: ThumbnailResult[];
}

describe("crashes at the success-commit boundary", () => {
  let harness: TestHarness;
  let image: Buffer;

  // A fresh harness (and so a fresh queue) per test, not per file: each test
  // here leaves a worker permanently "stuck" on a gate that's never
  // released, by design. A worker left running past the end of one test
  // would still be listening on a shared queue and could silently steal the
  // next test's job -- exactly the kind of race these tests exist to rule
  // out, so it's worth avoiding by construction rather than by discipline.
  beforeEach(async () => {
    harness = await createTestHarness({
      LOCK_DURATION_MS: 500,
      STALLED_INTERVAL_MS: 200,
      MAX_STALLED_COUNT: 3,
      WORKER_CONCURRENCY: 1,
    });
    image = await sampleImageBuffer();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("a crash immediately before the success update lets a clean replacement own and publish the result", async () => {
    const { job } = await submitImageJob(
      { pool: harness.pool, dispatcher: harness.dispatcher, storagePaths: harness.storagePaths, maxJobAttempts: harness.config.MAX_JOB_ATTEMPTS },
      { idempotencyKey: randomUUID(), file: { buffer: image, originalname: "before.jpg" }, isDemo: true },
    );

    // Never released in this test: a real crash right here means this
    // attempt's transitionToSucceeded call never happens, period -- there
    // is nothing to "release" afterward.
    const stuckGate = createGate();
    const { worker: crashingWorker, connection: crashingConnection } = harness.startWorker("demo", {}, { beforeSuccessCommit: stuckGate.wait });

    await waitFor(async () => (await getJobById(harness.pool, job.id))?.status === "running");
    const crashedToken = (await getJobById(harness.pool, job.id))?.running_token;
    expect(crashedToken).toBeTruthy();
    // Its files are already fully generated and closed by the time it
    // reaches the gate -- the crash lands strictly after that.
    expect(existsSync(attemptResultDirFor(harness.storagePaths, job.id, crashedToken!))).toBe(true);

    // The crash itself: sever the connection without a graceful close, so
    // this attempt's lock stops renewing. Its parked call stack is
    // otherwise untouched -- it simply never reaches transitionToSucceeded.
    crashingConnection.disconnect();
    void crashingWorker.close(true).catch(() => {});

    harness.startWorker("demo");
    await waitFor(async () => (await getJobById(harness.pool, job.id))?.status === "succeeded", 10_000);

    const succeededJob = (await getJobById(harness.pool, job.id)) as JobRow;
    expect(succeededJob.result_attempt_token).toBeTruthy();
    expect(succeededJob.result_attempt_token).not.toBe(crashedToken);

    const result = succeededJob.result as JobResult;
    expect(result.thumbnails).toHaveLength(3);
    for (const t of result.thumbnails) {
      const onDisk = attemptThumbnailPathFor(harness.storagePaths, job.id, succeededJob.result_attempt_token!, t.label);
      const bytes = await readFile(onDisk);
      expect(bytes.byteLength).toBeGreaterThan(0);
    }

    // The crashed attempt's directory is still sitting there -- it never
    // ran its own cleanup, because it never got the chance to. This is the
    // expected shape of a genuine crash, not a bug.
    expect(existsSync(attemptResultDirFor(harness.storagePaths, job.id, crashedToken!))).toBe(true);

    // Retention is the documented backstop for exactly this: sweeping a
    // terminal job removes every attempt directory under it, the orphan
    // and the (already-retention-eligible) winner alike.
    await sweepOnce({ pool: harness.pool, storagePaths: harness.storagePaths, logger: harness.dispatcher.logger, retentionMinutes: 0 });
    expect(existsSync(attemptResultDirFor(harness.storagePaths, job.id, crashedToken!))).toBe(false);
    expect(existsSync(attemptResultDirFor(harness.storagePaths, job.id, succeededJob.result_attempt_token!))).toBe(false);
  }, 20_000);

  it("a crash immediately after the success update leaves the committed result authoritative, and a stalled redelivery is a pure duplicate", async () => {
    const { job } = await submitImageJob(
      { pool: harness.pool, dispatcher: harness.dispatcher, storagePaths: harness.storagePaths, maxJobAttempts: harness.config.MAX_JOB_ATTEMPTS },
      { idempotencyKey: randomUUID(), file: { buffer: image, originalname: "after.jpg" }, isDemo: true },
    );

    // Never released: simulates the process vanishing the instant after
    // transitionToSucceeded resolves, before this attempt gets to do
    // anything else (recordAttemptEnd, metrics, its own log line).
    const stuckGate = createGate();
    const { worker: crashingWorker, connection: crashingConnection } = harness.startWorker("demo", {}, { afterSuccessCommit: stuckGate.wait });

    await waitFor(async () => (await getJobById(harness.pool, job.id))?.status === "succeeded", 10_000);

    const succeededJob = (await getJobById(harness.pool, job.id)) as JobRow;
    expect(succeededJob.result_attempt_token).toBeTruthy();
    const result = succeededJob.result as JobResult;
    expect(result.thumbnails).toHaveLength(3);

    const winningBytes = new Map<string, Buffer>();
    for (const t of result.thumbnails) {
      const onDisk = attemptThumbnailPathFor(harness.storagePaths, job.id, succeededJob.result_attempt_token!, t.label);
      winningBytes.set(t.label, await readFile(onDisk));
    }

    // recordAttemptEnd is on the far side of the gate, so this attempt's own
    // history row is truthfully still 'running' -- an honest record of "the
    // process died before it finished its own bookkeeping," not a
    // correctness problem: the job-level row already committed everything
    // that matters.
    const attemptsAfterCommit = await listJobAttempts(harness.pool, job.id);
    expect(attemptsAfterCommit).toHaveLength(1);
    expect(attemptsAfterCommit[0]?.status).toBe("running");

    // Now actually sever the connection so its lock stops renewing --
    // BullMQ will eventually consider the job stalled and redeliver it,
    // even though Postgres already has a terminal result for it.
    crashingConnection.disconnect();
    void crashingWorker.close(true).catch(() => {});
    harness.startWorker("demo");

    // Give the redelivery time to land and hit the duplicate-delivery guard
    // at the very top of processJob.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const afterRedelivery = await getJobById(harness.pool, job.id);
    expect(afterRedelivery?.status).toBe("succeeded");
    expect(afterRedelivery?.result_attempt_token).toBe(succeededJob.result_attempt_token);
    expect(afterRedelivery?.result).toEqual(result);

    // No new attempt row: the duplicate-delivery guard returns before
    // recordAttemptStart is ever called for a redelivery of a terminal job.
    const attemptsAfterRedelivery = await listJobAttempts(harness.pool, job.id);
    expect(attemptsAfterRedelivery).toHaveLength(1);

    // And the published files are untouched -- the duplicate delivery never
    // calls generateThumbnails again.
    for (const t of result.thumbnails) {
      const onDisk = attemptThumbnailPathFor(harness.storagePaths, job.id, succeededJob.result_attempt_token!, t.label);
      const bytes = await readFile(onDisk);
      expect(bytes.equals(winningBytes.get(t.label)!)).toBe(true);
    }
  }, 20_000);
});
