// Shared helpers for integration tests. These tests hit *real* Postgres and
// Redis (docker compose up -d must already be running) -- there is no
// mocking here on purpose, per the assignment's "meaningful verification"
// requirement.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { Redis } from "ioredis";
import { Worker } from "bullmq";
import sharp from "sharp";
import { runMigrations } from "../../src/db/migrate.js";
import { upsertWorkerHeartbeat, deleteWorker, type WorkerKind } from "../../src/db/jobsRepo.js";
import type { JobQueueData } from "../../src/queue/queue.js";
import { createQueueSet, type QueueSet } from "../../src/queue/queue.js";
import { makeBackoffStrategy } from "../../src/queue/backoff.js";
import { makeProcessor } from "../../src/worker/processor.js";
import { startOutboxSweeper, type DispatcherDeps } from "../../src/outbox/dispatcher.js";
import { resolveStoragePaths, ensureStorageDirs, type StoragePaths } from "../../src/storage/paths.js";
import { logger } from "../../src/logger.js";
import type { Config } from "../../src/config.js";

const TEST_DATABASE_URL = process.env.DATABASE_URL ?? "postgres://jobrelay:jobrelay@localhost:5432/jobrelay";
const TEST_REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

// pino is noisy for a test run; silence it unless LOG_LEVEL is set explicitly.
if (!process.env.LOG_LEVEL) logger.level = "silent";

export const testConfig: Config = {
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  PORT: 0,
  DATABASE_URL: TEST_DATABASE_URL,
  REDIS_URL: TEST_REDIS_URL,
  // Overwritten per-harness in createTestHarness() so multiple harnesses
  // created within the same test file never share a BullMQ queue.
  MAIN_QUEUE_NAME: "jobrelay-test-main-placeholder",
  DEMO_QUEUE_NAME: "jobrelay-test-demo-placeholder",
  MAX_UPLOAD_BYTES: 5_000_000,
  MAX_IMAGE_DIMENSION_PX: 4000,
  MAX_IMAGE_PIXELS: 16_000_000,
  MAX_JOB_ATTEMPTS: 3,
  BACKOFF_BASE_MS: 30,
  BACKOFF_MAX_MS: 200,
  BACKOFF_JITTER: 0.2,
  WORKER_CONCURRENCY: 2,
  LOCK_DURATION_MS: 2000,
  STALLED_INTERVAL_MS: 500,
  MAX_STALLED_COUNT: 2,
  OUTBOX_SWEEP_INTERVAL_MS: 200,
  OUTBOX_BATCH_SIZE: 50,
  WORKER_HEARTBEAT_INTERVAL_MS: 250,
  WORKER_OFFLINE_THRESHOLD_MS: 1000,
  STORAGE_DIR: "jobrelay-test-storage-placeholder",
  RETENTION_MINUTES: 60,
  RETENTION_SWEEP_INTERVAL_MS: 60_000,
  DEMO_ENABLED: true,
  DEMO_WORKER_COUNT: 2,
  WORKER_KIND: "main",
  WORKER_ID_OVERRIDE: undefined,
};

export interface TestHarness {
  config: Config;
  pool: Pool;
  apiRedis: Redis;
  queues: QueueSet;
  dispatcher: DispatcherDeps;
  sweeper: { stop: () => void };
  storagePaths: StoragePaths;
  /** Starts a fresh worker (its own Redis connection, its own worker id). Caller must close it. */
  startWorker: (kind: WorkerKind, overrides?: Partial<Config>) => { worker: Worker<JobQueueData>; workerId: string; connection: Redis };
  cleanup: () => Promise<void>;
}

export async function createTestHarness(configOverrides: Partial<Config> = {}): Promise<TestHarness> {
  const suffix = randomUUID().slice(0, 8);
  const storageDir = await mkdtemp(join(tmpdir(), "jobrelay-test-"));
  const config: Config = {
    ...testConfig,
    MAIN_QUEUE_NAME: `jobrelay-test-main-${suffix}`,
    DEMO_QUEUE_NAME: `jobrelay-test-demo-${suffix}`,
    STORAGE_DIR: storageDir,
    ...configOverrides,
  };
  const pool = new Pool({ connectionString: config.DATABASE_URL, max: 5 });
  pool.on("error", () => {});
  await runMigrations(pool);

  const storagePaths = resolveStoragePaths(config.STORAGE_DIR);
  await ensureStorageDirs(storagePaths);

  const apiRedis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2, connectTimeout: 3000 });
  apiRedis.on("error", () => {}); // the redis-outage test deliberately stops/starts the container
  const queues = createQueueSet(config, apiRedis);

  const dispatcher: DispatcherDeps = { pool, queues, logger, batchSize: config.OUTBOX_BATCH_SIZE };
  const sweeper = startOutboxSweeper(dispatcher, config.OUTBOX_SWEEP_INTERVAL_MS);

  const workers: Array<{ worker: Worker<JobQueueData>; connection: Redis; workerId: string }> = [];

  function startWorker(kind: WorkerKind, overrides: Partial<Config> = {}) {
    const workerConfig = { ...config, ...overrides };
    const workerId = `test-${kind}-${randomUUID().slice(0, 8)}`;
    const queueName = kind === "demo" ? workerConfig.DEMO_QUEUE_NAME : workerConfig.MAIN_QUEUE_NAME;
    const connection = new Redis(workerConfig.REDIS_URL, { maxRetriesPerRequest: null });

    let currentJobId: string | null = null;
    const heartbeat = (status: "idle" | "busy") =>
      upsertWorkerHeartbeat(pool, { id: workerId, kind, pid: process.pid, status, currentJobId }).catch(() => {});

    const processor = makeProcessor({
      pool,
      logger,
      workerId,
      storagePaths,
      imageLimits: { maxUploadBytes: workerConfig.MAX_UPLOAD_BYTES, maxDimensionPx: workerConfig.MAX_IMAGE_DIMENSION_PX, maxPixels: workerConfig.MAX_IMAGE_PIXELS },
      onJobStart: (jobId) => {
        currentJobId = jobId;
        void heartbeat("busy");
      },
      onJobEnd: () => {
        currentJobId = null;
        void heartbeat("idle");
      },
    });
    const worker = new Worker<JobQueueData>(queueName, processor, {
      connection,
      concurrency: workerConfig.WORKER_CONCURRENCY,
      lockDuration: workerConfig.LOCK_DURATION_MS,
      stalledInterval: workerConfig.STALLED_INTERVAL_MS,
      maxStalledCount: workerConfig.MAX_STALLED_COUNT,
      settings: { backoffStrategy: makeBackoffStrategy(workerConfig) },
    });
    // A Worker (or its Redis connection) that emits 'error' with no listener
    // registered would throw and crash the whole test process -- notably
    // exercised by the crash-recovery and redis-outage tests, which
    // deliberately sever connections mid-flight.
    worker.on("error", () => {});
    connection.on("error", () => {});
    void heartbeat("idle");
    workers.push({ worker, connection, workerId });
    return { worker, workerId, connection };
  }

  async function cleanup(): Promise<void> {
    sweeper.stop();
    for (const w of workers) {
      await w.worker.close(true).catch(() => {});
      w.connection.disconnect();
      await deleteWorker(pool, w.workerId).catch(() => {});
    }
    await queues.main.obliterate({ force: true }).catch(() => {});
    await queues.demo.obliterate({ force: true }).catch(() => {});
    await queues.main.close();
    await queues.demo.close();
    apiRedis.disconnect();
    await pool.end();
    await rm(storageDir, { recursive: true, force: true }).catch(() => {});
  }

  return { config, pool, apiRedis, queues, dispatcher, sweeper, storagePaths, startWorker, cleanup };
}

/** Waits until `predicate()` resolves truthy, polling every `intervalMs`, up to `timeoutMs`. */
export async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 10_000, intervalMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** A tiny, valid JPEG generated on the fly -- no fixture file needed. */
export async function sampleImageBuffer(width = 300, height = 200): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 120, g: 150, b: 130 } } })
    .jpeg()
    .toBuffer();
}

export function corruptImageBuffer(): Buffer {
  return Buffer.from("this is not an image, just some bytes pretending to be one");
}

export async function oversizedImageBuffer(dimension: number): Promise<Buffer> {
  return sharp({ create: { width: dimension, height: dimension, channels: 3, background: { r: 10, g: 10, b: 10 } } })
    .png()
    .toBuffer();
}

/** Turns a test harness's Config into env-var overrides for a spawned child worker process (see demoPanel.test.ts), so the child sees the same test database/queues/limits as the harness that created it. */
export function configToEnvOverrides(config: Config): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    // PORT is irrelevant to a worker process (only the API binds a port) and
    // the harness sets it to 0 as a "don't care" placeholder, which the
    // config schema itself would reject -- skip it along with the two
    // fields DemoWorkerManager sets itself.
    if (value === undefined || key === "WORKER_KIND" || key === "WORKER_ID_OVERRIDE" || key === "PORT") continue;
    overrides[key] = String(value);
  }
  return overrides;
}
