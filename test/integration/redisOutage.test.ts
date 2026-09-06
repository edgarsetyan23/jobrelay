// Requires `docker compose up -d` AND that this test can shell out to the
// `docker` CLI to stop/start the `jobrelay-redis` container by name (see
// docker-compose.yml). This is the one test that reaches outside the Node
// process to simulate a real infrastructure outage rather than a mocked one.
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { submitImageJob } from "../../src/api/submitImageJob.js";
import { getJobById } from "../../src/db/jobsRepo.js";
import { createTestHarness, sampleImageBuffer, waitFor, type TestHarness } from "./setup.js";

const REDIS_CONTAINER = "jobrelay-redis";

function dockerAvailable(): boolean {
  try {
    execSync(`docker inspect ${REDIS_CONTAINER}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!dockerAvailable())("Redis outage after Postgres acceptance", () => {
  let harness: TestHarness;
  let image: Buffer;

  beforeAll(async () => {
    harness = await createTestHarness({ OUTBOX_SWEEP_INTERVAL_MS: 200 });
    harness.startWorker("main");
    image = await sampleImageBuffer();
  }, 30_000);

  afterAll(async () => {
    await harness.cleanup();
    execSync(`docker start ${REDIS_CONTAINER}`, { stdio: "ignore" }); // safety net in case a step above threw
  }, 60_000);

  it(
    "accepts the job durably while Redis is down, then dispatches and processes it once Redis recovers",
    async () => {
      execSync(`docker stop ${REDIS_CONTAINER}`, { stdio: "ignore" });

      try {
        const { job } = await submitImageJob(
          { pool: harness.pool, dispatcher: harness.dispatcher, storagePaths: harness.storagePaths, maxJobAttempts: harness.config.MAX_JOB_ATTEMPTS },
          { idempotencyKey: randomUUID(), file: { buffer: image, originalname: "a.jpg" }, isDemo: false },
        );

        // Postgres accepted it durably regardless of Redis being reachable.
        const stored = await getJobById(harness.pool, job.id);
        expect(stored?.status).toBe("queued");

        await new Promise((resolve) => setTimeout(resolve, 500));
        const stillQueued = await getJobById(harness.pool, job.id);
        expect(stillQueued?.status).toBe("queued");

        const { rows } = await harness.pool.query("SELECT published FROM outbox_events WHERE job_id = $1", [job.id]);
        expect(rows[0]?.published).toBe(false);

        execSync(`docker start ${REDIS_CONTAINER}`, { stdio: "ignore" });

        // Once Redis is back: the sweeper publishes the outbox event, and
        // the already-running worker (whose own connection reconnects on
        // its own retry strategy) picks the job up and completes it.
        await waitFor(async () => (await getJobById(harness.pool, job.id))?.status === "succeeded", 30_000, 300);

        const final = await getJobById(harness.pool, job.id);
        expect(final?.status).toBe("succeeded");
        expect(final?.result).toBeTruthy();
      } finally {
        execSync(`docker start ${REDIS_CONTAINER}`, { stdio: "ignore" });
      }
    },
    60_000,
  );
});
