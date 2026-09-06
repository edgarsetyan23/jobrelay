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
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { submitImageJob } from "../../src/api/submitImageJob.js";
import { getJobById, listJobAttempts } from "../../src/db/jobsRepo.js";
import { createTestHarness, sampleImageBuffer, waitFor, type TestHarness } from "./setup.js";

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
    // `slow` with no `onlyOnAttempt` applies to every attempt: attempt 1
    // (the soon-to-be-abandoned worker) and attempt 2 (its recovery) both
    // sleep for the full delay. That guarantees a window where attempt 2 has
    // already re-entered 'running' (overwriting the fencing token) while
    // attempt 1's own delayed finalize is still in flight and about to land.
    const { job } = await submitImageJob(
      { pool: harness.pool, dispatcher: harness.dispatcher, storagePaths: harness.storagePaths, maxJobAttempts: harness.config.MAX_JOB_ATTEMPTS },
      {
        idempotencyKey: randomUUID(),
        file: { buffer: image, originalname: "slow-both.jpg" },
        isDemo: true,
        fault: { mode: "slow", delayMs: 1500 },
      },
    );

    const { worker: staleWorker, connection: staleConnection } = harness.startWorker("demo");

    await waitFor(async () => (await getJobById(harness.pool, job.id))?.status === "running");
    const afterFirstClaim = await getJobById(harness.pool, job.id);
    const firstToken = afterFirstClaim?.running_token;
    expect(firstToken).toBeTruthy();

    // Sever the connection *without* closing the worker cleanly (no
    // worker.close()) -- the worker process is, from BullMQ's point of view,
    // gone: it stops renewing its lock. But its already-running processJob()
    // call (including the in-flight `slow` setTimeout) keeps executing in
    // this same Node process regardless, exactly like a worker whose event
    // loop is merely stalled rather than actually dead.
    staleConnection.disconnect();
    void staleWorker.close(true).catch(() => {});

    // The recovering worker picks the job up once the stalled-job check
    // fires and re-enters 'running', claiming a fresh token.
    const recoveryClaimedAt = Date.now();
    harness.startWorker("demo");
    await waitFor(async () => {
      const row = await getJobById(harness.pool, job.id);
      return row?.status === "running" && row.running_token !== firstToken;
    });

    // At this point: attempt 1's finalize (still queued behind its own
    // setTimeout, holding the *old* token) has not landed yet, and attempt 2
    // is itself still sleeping through its own `slow` fault. Neither attempt
    // has reached a terminal state -- this is exactly the non-terminal race
    // window the old status-only guard couldn't arbitrate.
    const midway = await getJobById(harness.pool, job.id);
    expect(midway?.status).toBe("running");

    await waitFor(async () => (await getJobById(harness.pool, job.id))?.status === "succeeded", 10_000);
    const final = await getJobById(harness.pool, job.id);
    expect(final?.status).toBe("succeeded");

    // The critical assertion: the job only ever finished once the recovering
    // attempt's own (slow) work actually completed -- roughly one fault
    // delay after it claimed ownership. Attempt 1's finalize landed earlier
    // than that (its setTimeout started well before attempt 2's), so if the
    // old status-only guard had let it win, `finished_at` would sit far
    // closer to `recoveryClaimedAt` than a full fault delay allows.
    const finishedAfterClaimMs = final!.finished_at!.getTime() - recoveryClaimedAt;
    expect(finishedAfterClaimMs).toBeGreaterThanOrEqual(1200);

    const attempts = await listJobAttempts(harness.pool, job.id);
    expect(attempts).toHaveLength(2);
    const workerIds = new Set(attempts.map((a) => a.worker_id));
    // Two distinct worker processes actually ran this job -- attempt 1 (now
    // stale) and attempt 2 (the recovery) -- confirming this was a genuine
    // ownership race between two live attempts, not just a dead worker whose
    // write bounced off an already-terminal row.
    expect(workerIds.size).toBe(2);
  }, 20_000);
});
