// Requires `docker compose up -d` (real Postgres + Redis) beforehand.
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.js";
import { createTestHarness, sampleImageBuffer, waitFor, type TestHarness } from "./setup.js";

describe("JobRelay API + worker: normal upload flow", () => {
  let harness: TestHarness;
  let app: ReturnType<typeof createApp>;
  let image: Buffer;

  beforeAll(async () => {
    harness = await createTestHarness({ DEMO_ENABLED: false });
    app = createApp({
      pool: harness.pool,
      redis: harness.apiRedis,
      dispatcher: harness.dispatcher,
      storagePaths: harness.storagePaths,
      config: harness.config,
      logger: harness.dispatcher.logger,
      publicDir: harness.storagePaths.root, // no frontend needed for these tests
    });
    harness.startWorker("main");
    image = await sampleImageBuffer();
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  it("accepts a valid upload with 202 and eventually completes it with three thumbnails", async () => {
    const idempotencyKey = randomUUID();
    const submit = await request(app).post("/api/jobs").set("Idempotency-Key", idempotencyKey).attach("image", image, "photo.jpg");

    expect(submit.status).toBe(202);
    expect(submit.body.job.status).toBe("queued");
    const jobId = submit.body.job.id as string;

    await waitFor(async () => {
      const res = await request(app).get(`/api/jobs/${jobId}`);
      return res.body.job.status === "succeeded";
    });

    const final = await request(app).get(`/api/jobs/${jobId}`);
    expect(final.body.job.result.thumbnails).toHaveLength(3);
    expect(final.body.job.result.thumbnails.map((t: { label: string }) => t.label).sort()).toEqual(["large", "medium", "small"]);
    for (const thumb of final.body.job.result.thumbnails) {
      const fileRes = await request(app).get(thumb.url);
      expect(fileRes.status).toBe(200);
      expect(fileRes.headers["content-type"]).toMatch(/image\/jpeg/);
    }
  });

  it("returns 400 when no file is attached", async () => {
    const res = await request(app).post("/api/jobs").set("Idempotency-Key", randomUUID());
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_FILE");
  });

  it("returns 400 when the Idempotency-Key header is missing", async () => {
    const res = await request(app).post("/api/jobs").attach("image", image, "photo.jpg");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_IDEMPOTENCY_KEY");
  });

  it("returns 404 for an unknown job id", async () => {
    const res = await request(app).get(`/api/jobs/${randomUUID()}`);
    expect(res.status).toBe(404);
  });

  it("replays the same job for a repeated idempotency key with an identical file", async () => {
    const idempotencyKey = randomUUID();
    const first = await request(app).post("/api/jobs").set("Idempotency-Key", idempotencyKey).attach("image", image, "a.jpg");
    const second = await request(app).post("/api/jobs").set("Idempotency-Key", idempotencyKey).attach("image", image, "a.jpg");

    expect(first.body.job.id).toBe(second.body.job.id);
    expect(second.body.replayed).toBe(true);
  });

  it("handles N concurrent submissions with the same idempotency key by creating exactly one job", async () => {
    const idempotencyKey = randomUUID();
    const concurrency = 8;

    const responses = await Promise.all(
      Array.from({ length: concurrency }, () => request(app).post("/api/jobs").set("Idempotency-Key", idempotencyKey).attach("image", image, "same.jpg")),
    );

    const ids = new Set(responses.map((r) => r.body.job.id));
    expect(ids.size).toBe(1);

    const { rows } = await harness.pool.query("SELECT count(*) FROM jobs WHERE idempotency_key = $1", [idempotencyKey]);
    expect(Number(rows[0].count)).toBe(1);
  });

  it("returns 409 when the same idempotency key is reused with a different file", async () => {
    const idempotencyKey = randomUUID();
    const differentImage = await sampleImageBuffer(50, 50);

    const first = await request(app).post("/api/jobs").set("Idempotency-Key", idempotencyKey).attach("image", image, "a.jpg");
    expect(first.status).toBe(202);

    const second = await request(app).post("/api/jobs").set("Idempotency-Key", idempotencyKey).attach("image", differentImage, "b.jpg");
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("IDEMPOTENCY_KEY_CONFLICT");
  });

  it("lists jobs with cursor pagination", async () => {
    for (let i = 0; i < 5; i++) {
      await request(app).post("/api/jobs").set("Idempotency-Key", randomUUID()).attach("image", image, "p.jpg");
    }

    const page1 = await request(app).get("/api/jobs?limit=2");
    expect(page1.body.jobs).toHaveLength(2);
    expect(page1.body.nextCursor).toBeTruthy();

    const page2 = await request(app).get(`/api/jobs?limit=2&cursor=${page1.body.nextCursor}`);
    expect(page2.body.jobs).toHaveLength(2);

    const ids1 = page1.body.jobs.map((j: { id: string }) => j.id);
    const ids2 = page2.body.jobs.map((j: { id: string }) => j.id);
    expect(ids1.some((id: string) => ids2.includes(id))).toBe(false);
  });

  it("exposes liveness and readiness endpoints", async () => {
    const live = await request(app).get("/healthz");
    expect(live.status).toBe(200);

    const ready = await request(app).get("/readyz");
    expect(ready.status).toBe(200);
    expect(ready.body.checks).toEqual({ database: "ok", redis: "ok" });
  });

  it("reports the running main worker on the worker-station endpoint", async () => {
    await waitFor(async () => {
      const res = await request(app).get("/api/workers");
      return res.body.workers.some((w: { kind: string; status: string }) => w.kind === "main" && (w.status === "idle" || w.status === "busy"));
    });
    const res = await request(app).get("/api/workers");
    expect(res.status).toBe(200);
  });
});
