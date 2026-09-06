// Requires `docker compose up -d`.
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.js";
import { createTestHarness, corruptImageBuffer, oversizedImageBuffer, waitFor, type TestHarness } from "./setup.js";

describe("image validation", () => {
  let harness: TestHarness;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    harness = await createTestHarness({ DEMO_ENABLED: false, MAX_UPLOAD_BYTES: 2_000_000, MAX_IMAGE_DIMENSION_PX: 1000, MAX_IMAGE_PIXELS: 800_000 });
    app = createApp({
      pool: harness.pool,
      redis: harness.apiRedis,
      dispatcher: harness.dispatcher,
      storagePaths: harness.storagePaths,
      config: harness.config,
      logger: harness.dispatcher.logger,
      publicDir: harness.storagePaths.root,
    });
    harness.startWorker("main");
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  it("rejects an oversized upload synchronously (413), before any job is created", async () => {
    const tooBig = Buffer.alloc(harness.config.MAX_UPLOAD_BYTES + 1, 1);
    const res = await request(app).post("/api/jobs").set("Idempotency-Key", randomUUID()).attach("image", tooBig, "big.jpg");
    expect(res.status).toBe(413);
  });

  it("accepts a corrupt (non-image) file, then fails it permanently without retries", async () => {
    const idempotencyKey = randomUUID();
    const submit = await request(app).post("/api/jobs").set("Idempotency-Key", idempotencyKey).attach("image", corruptImageBuffer(), "not-an-image.jpg");
    expect(submit.status).toBe(202);
    const jobId = submit.body.job.id as string;

    await waitFor(async () => (await request(app).get(`/api/jobs/${jobId}`)).body.job.status === "failed");

    const final = await request(app).get(`/api/jobs/${jobId}`);
    expect(final.body.job.attempts).toBe(1); // permanent failure: no retries
    expect(final.body.job.error).toMatch(/not a readable image|corrupt/i);
  });

  it("accepts an image exceeding the configured dimension limit, then fails it permanently", async () => {
    const huge = await oversizedImageBuffer(1500); // exceeds MAX_IMAGE_DIMENSION_PX=1000, but still under the byte-size limit
    const idempotencyKey = randomUUID();
    const submit = await request(app).post("/api/jobs").set("Idempotency-Key", idempotencyKey).attach("image", huge, "huge.png");
    expect(submit.status).toBe(202);
    const jobId = submit.body.job.id as string;

    await waitFor(async () => (await request(app).get(`/api/jobs/${jobId}`)).body.job.status === "failed");

    const final = await request(app).get(`/api/jobs/${jobId}`);
    expect(final.body.job.attempts).toBe(1);
    expect(final.body.job.error).toMatch(/exceeding the per-side limit/i);
  });
});
