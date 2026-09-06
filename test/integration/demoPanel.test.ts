// Requires `docker compose up -d`.
//
// End-to-end coverage of the interactive demonstration panel's own surface:
// the HTTP endpoint it submits through, and -- the one test in this suite
// that spawns a real OS process -- the actual "Stop this worker" control
// killing a real demo worker child process and a sibling worker recovering
// its job. Slower and marginally more fragile than the rest of the suite
// (real process startup time), which is why it's isolated in its own file.
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.js";
import { DemoWorkerManager } from "../../src/api/demoWorkerManager.js";
import { getJobById, listJobAttempts, listWorkers } from "../../src/db/jobsRepo.js";
import { logger } from "../../src/logger.js";
import { configToEnvOverrides, createTestHarness, sampleImageBuffer, waitFor, type TestHarness } from "./setup.js";

describe("demo panel: HTTP fault injection", () => {
  let harness: TestHarness;
  let app: ReturnType<typeof createApp>;
  let image: Buffer;
  let idleDemoManager: DemoWorkerManager; // count: 0 -- just satisfies createApp's type, spawns nothing

  beforeAll(async () => {
    harness = await createTestHarness({ MAX_JOB_ATTEMPTS: 3, BACKOFF_BASE_MS: 30, BACKOFF_MAX_MS: 200 });
    idleDemoManager = new DemoWorkerManager({ count: 0, logger, env: process.env });
    app = createApp({
      pool: harness.pool,
      redis: harness.apiRedis,
      dispatcher: harness.dispatcher,
      storagePaths: harness.storagePaths,
      config: harness.config,
      logger: harness.dispatcher.logger,
      demoWorkers: idleDemoManager,
      publicDir: harness.storagePaths.root,
    });
    harness.startWorker("demo");
    image = await sampleImageBuffer();
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  it("processes a demo submission with a 'fail this attempt' fault and recovers", async () => {
    const idempotencyKey = randomUUID();
    const fault = JSON.stringify({ mode: "transient-fail-count", failCount: 1 });
    const submit = await request(app).post("/api/demo/jobs").set("Idempotency-Key", idempotencyKey).field("fault", fault).attach("image", image, "demo.jpg");

    expect(submit.status).toBe(202);
    expect(submit.body.job.isDemo).toBe(true);
    const jobId = submit.body.job.id as string;

    await waitFor(async () => (await request(app).get(`/api/jobs/${jobId}`)).body.job.status === "succeeded");
    const attempts = await listJobAttempts(harness.pool, jobId);
    expect(attempts.map((a) => a.status)).toEqual(["retrying", "succeeded"]);
  });

  it("returns 404 when asked to stop a worker id that isn't a tracked demo worker", async () => {
    const res = await request(app).post("/api/demo/workers/not-a-real-worker/stop");
    expect(res.status).toBe(404);
  });
});

describe("demo panel: real 'Stop this worker' process control", () => {
  let harness: TestHarness;
  let demoManager: DemoWorkerManager | undefined;

  afterEach(async () => {
    demoManager?.stopAll();
    await harness?.cleanup();
  });

  it(
    "kills a real demo worker child process mid-job, and a sibling worker completes the job after the queue detects the failure",
    async () => {
      harness = await createTestHarness({ LOCK_DURATION_MS: 1000, STALLED_INTERVAL_MS: 300, MAX_STALLED_COUNT: 3, WORKER_CONCURRENCY: 1 });
      const image = await sampleImageBuffer();

      demoManager = new DemoWorkerManager({
        count: 1,
        logger,
        env: { ...process.env, ...configToEnvOverrides(harness.config) },
        respawnDelayMs: 60_000, // don't let the test race its own respawn logic
      });
      demoManager.start();

      // Wait for the real child process to boot, connect, and heartbeat.
      await waitFor(async () => (await listWorkers(harness.pool)).some((w) => w.kind === "demo"), 20_000, 250);
      const childId = demoManager.ids()[0]!;

      const { submitImageJob } = await import("../../src/api/submitImageJob.js");
      const { job } = await submitImageJob(
        { pool: harness.pool, dispatcher: harness.dispatcher, storagePaths: harness.storagePaths, maxJobAttempts: harness.config.MAX_JOB_ATTEMPTS },
        { idempotencyKey: randomUUID(), file: { buffer: image, originalname: "kill-me.jpg" }, isDemo: true, fault: { mode: "slow", delayMs: 4000, onlyOnAttempt: 1 } },
      );

      // Only the real child is running right now, so it must be the one that picks this up.
      await waitFor(async () => (await getJobById(harness.pool, job.id))?.status === "running", 15_000);

      const stopped = demoManager.stop(childId);
      expect(stopped).toBe(true);

      // The sibling that recovers the job -- an ordinary in-process demo worker is a fine stand-in for "a second demo worker instance".
      harness.startWorker("demo");

      await waitFor(async () => (await getJobById(harness.pool, job.id))?.status === "succeeded", 20_000, 300);
      const final = await getJobById(harness.pool, job.id);
      expect(final?.status).toBe("succeeded");

      // The killed child never got to clean up its own row -- it should age
      // out to "offline" on the worker-station board, not just vanish or
      // linger as "idle"/"busy" forever.
      await waitFor(
        async () => {
          const rows = await listWorkers(harness.pool);
          const row = rows.find((w) => w.id === childId);
          if (!row) return true; // acceptable: row absent entirely also reads as "not available"
          const staleMs = Date.now() - row.last_heartbeat_at.getTime();
          return staleMs > harness.config.WORKER_OFFLINE_THRESHOLD_MS;
        },
        10_000,
        250,
      );
    },
    60_000,
  );
});
