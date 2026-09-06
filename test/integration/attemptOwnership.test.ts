// Requires `docker compose up -d`.
//
// crashRecovery.test.ts proves a *stale* write arriving after the job is
// already terminal is safely ignored -- but that alone doesn't prove much,
// because the old status-only guard (`status NOT IN ('succeeded','failed')`)
// already rejects any write once the row is terminal. The gap this test
// closes: what happens when the original worker's lock merely *expired*
// (BullMQ can't tell that apart from a real crash) and it is in fact still
// alive and still processing, so its eventual finalize call lands while the
// job is still non-terminal ('running') -- at the same moment a second,
// independently-recovering attempt is also mid-flight. Without an ownership
// check, whichever of the two finishes first wins arbitrarily, even though
// only the recovering attempt is "supposed to" own the job by then.
//
// This uses a manually-controlled gate (`beforeSuccessCommit`), not a timed
// `slow` fault, to hold the stale attempt open: two independent delays only
// ever *tend* to produce "stale finalizes after the winner" -- they don't
// guarantee it, especially under CI load. The gate makes the ordering exact.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { submitImageJob } from "../../src/api/submitImageJob.js";
import { getJobById, listJobAttempts } from "../../src/db/jobsRepo.js";
import { createGate, createTestHarness, sampleImageBuffer, waitFor, type TestHarness } from "./setup.js";

describe("attempt ownership (fencing token)", () => {
  let harness: TestHarness;
  let image: Buffer;

  beforeAll(async () => {
    harness = await createTestHarness({
      LOCK_DURATION_MS: 500,
      STALLED_INTERVAL_MS: 200,
      MAX_STALLED_COUNT: 3,
      WORKER_CONCURRENCY: 1,
    });
    image = await sampleImageBuffer();
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  it("blocks a still-alive, lock-expired attempt from finalizing a job its replacement has already re-claimed", async () => {
    const { job } = await submitImageJob(
      { pool: harness.pool, dispatcher: harness.dispatcher, storagePaths: harness.storagePaths, maxJobAttempts: harness.config.MAX_JOB_ATTEMPTS },
      { idempotencyKey: randomUUID(), file: { buffer: image, originalname: "gate.jpg" }, isDemo: true },
    );

    // Held closed until step 4 below.
    const staleGate = createGate();
    const { worker: staleWorker, connection: staleConnection } = harness.startWorker("demo", {}, { beforeSuccessCommit: staleGate.wait });

    // 1. The stale attempt does its real work (fully generates and closes
    //    its thumbnails) and reaches the pre-commit boundary -- files done,
    //    about to call transitionToSucceeded -- then blocks on the gate.
    await waitFor(async () => (await getJobById(harness.pool, job.id))?.status === "running");
    const firstToken = (await getJobById(harness.pool, job.id))?.running_token;
    expect(firstToken).toBeTruthy();

    // 2. "Crash" it: sever its connection without a graceful close, so it
    //    stops renewing its lock. Its call stack -- parked on the gate --
    //    is untouched by this, exactly like a worker whose event loop has
    //    stalled but hasn't actually exited.
    staleConnection.disconnect();
    void staleWorker.close(true).catch(() => {});

    // 3. The recovery worker picks the job up once BullMQ's stalled-job
    //    check fires, and completes it normally -- no gate on this one.
    harness.startWorker("demo");
    await waitFor(async () => (await getJobById(harness.pool, job.id))?.status === "succeeded", 10_000);
    const winner = await getJobById(harness.pool, job.id);
    expect(winner?.running_token).not.toBe(firstToken);
    expect(winner?.result_attempt_token).toBe(winner?.running_token);

    // 4. Only now release the stale attempt -- this *guarantees*, rather
    //    than merely makes likely, that its transitionToSucceeded call
    //    lands strictly after the winner's.
    staleGate.release();

    await waitFor(async () => {
      const attempts = await listJobAttempts(harness.pool, job.id);
      return attempts.length === 2 && attempts.every((a) => a.status === "succeeded");
    });

    // The critical assertion: the stale attempt's finalize call, landing
    // deterministically after the winner's, must not have been able to
    // touch the job row at all.
    const afterStaleFinalize = await getJobById(harness.pool, job.id);
    expect(afterStaleFinalize?.status).toBe("succeeded");
    expect(afterStaleFinalize?.running_token).toBe(winner?.running_token);
    expect(afterStaleFinalize?.result_attempt_token).toBe(winner?.result_attempt_token);
    expect(afterStaleFinalize?.result).toEqual(winner?.result);

    // Two distinct worker processes actually ran this job -- confirming
    // this was a genuine ownership race between two live attempts, not
    // just a dead worker whose write bounced off an already-terminal row.
    const attempts = await listJobAttempts(harness.pool, job.id);
    const workerIds = new Set(attempts.map((a) => a.worker_id));
    expect(workerIds.size).toBe(2);
  }, 20_000);
});
