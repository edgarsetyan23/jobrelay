// Requires `docker compose up -d`. Exercises the same retry/backoff/exhaustion
// machinery the "Fail this attempt" demo control uses, via the shared
// submitImageJob() path (isDemo: true) rather than a full HTTP round trip --
// see demoPanel.test.ts for the HTTP-level version of the same feature.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { submitImageJob } from "../../src/api/submitImageJob.js";
import { getJobById, listJobAttempts } from "../../src/db/jobsRepo.js";
import { createTestHarness, sampleImageBuffer, waitFor, type TestHarness } from "./setup.js";

describe("retry behavior (demo queue)", () => {
  let harness: TestHarness;
  let image: Buffer;

  beforeAll(async () => {
    harness = await createTestHarness({ MAX_JOB_ATTEMPTS: 3, BACKOFF_BASE_MS: 30, BACKOFF_MAX_MS: 200 });
    harness.startWorker("demo");
    image = await sampleImageBuffer();
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  it("recovers from a transient failure and succeeds on a later attempt", async () => {
    const { job } = await submitImageJob(
      { pool: harness.pool, dispatcher: harness.dispatcher, storagePaths: harness.storagePaths, maxJobAttempts: harness.config.MAX_JOB_ATTEMPTS },
      { idempotencyKey: randomUUID(), file: { buffer: image, originalname: "a.jpg" }, isDemo: true, fault: { mode: "transient-fail-count", failCount: 1 } },
    );

    await waitFor(async () => (await getJobById(harness.pool, job.id))?.status === "succeeded");

    const final = await getJobById(harness.pool, job.id);
    expect(final?.attempts).toBe(2);
    expect(final?.result).toBeTruthy();

    const attempts = await listJobAttempts(harness.pool, job.id);
    expect(attempts.map((a) => a.status)).toEqual(["retrying", "succeeded"]);
  });

  it("exhausts retries and lands in failed with full attempt history preserved", async () => {
    const { job } = await submitImageJob(
      { pool: harness.pool, dispatcher: harness.dispatcher, storagePaths: harness.storagePaths, maxJobAttempts: harness.config.MAX_JOB_ATTEMPTS },
      { idempotencyKey: randomUUID(), file: { buffer: image, originalname: "b.jpg" }, isDemo: true, fault: { mode: "always-fail" } },
    );

    await waitFor(async () => (await getJobById(harness.pool, job.id))?.status === "failed", 15_000);

    const final = await getJobById(harness.pool, job.id);
    expect(final?.status).toBe("failed");
    expect(final?.attempts).toBe(3);
    expect(final?.error).toMatch(/retries exhausted/i);

    const attempts = await listJobAttempts(harness.pool, job.id);
    expect(attempts).toHaveLength(3);
    expect(attempts[attempts.length - 1]?.status).toBe("failed");
  });

  it("never honors a fault spec on a normal (non-demo) submission", async () => {
    const { job } = await submitImageJob(
      { pool: harness.pool, dispatcher: harness.dispatcher, storagePaths: harness.storagePaths, maxJobAttempts: harness.config.MAX_JOB_ATTEMPTS },
      // isDemo: false -- submitImageJob only attaches `_fault` to the payload when isDemo is true, so this fault is simply dropped.
      { idempotencyKey: randomUUID(), file: { buffer: image, originalname: "c.jpg" }, isDemo: false, fault: { mode: "always-fail" } },
    );
    const stored = await getJobById(harness.pool, job.id);
    expect((stored?.payload as Record<string, unknown>)._fault).toBeUndefined();
  });
});
