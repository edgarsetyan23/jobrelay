// Reproducible throughput benchmark: submits a fixed batch of real image
// jobs through the real HTTP API, at each of several WORKER_CONCURRENCY
// settings, against real Postgres + Redis. No mocks, no synthetic timers --
// every number below comes from actual job rows.
//
// Usage:
//   npm run bench
//   npm run bench -- --jobs=100 --concurrencies=1,2,4,8
//
// Requires `docker compose up -d` first. Uses its own queue names and a
// scratch STORAGE_DIR per run so it never collides with a real API/worker
// you might also have running.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { Pool } from "pg";
import { Redis } from "ioredis";
import { Worker } from "bullmq";
import sharp from "sharp";
import { runMigrations } from "../src/db/migrate.js";
import { createQueueSet, type JobQueueData } from "../src/queue/queue.js";
import { makeBackoffStrategy } from "../src/queue/backoff.js";
import { makeProcessor } from "../src/worker/processor.js";
import { startOutboxSweeper, type DispatcherDeps } from "../src/outbox/dispatcher.js";
import { resolveStoragePaths, ensureStorageDirs } from "../src/storage/paths.js";
import { createApp } from "../src/api/app.js";
import { logger } from "../src/logger.js";
import type { Config } from "../src/config.js";

logger.level = "silent"; // keep the benchmark's own table readable

function parseArgs(): { jobs: number; concurrencies: number[] } {
  const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.slice(2).split("=") as [string, string]));
  return {
    jobs: args.jobs ? Number(args.jobs) : 60,
    concurrencies: (args.concurrencies ? args.concurrencies.split(",") : ["1", "2", "4", "8"]).map(Number),
  };
}

interface RunResult {
  concurrency: number;
  jobs: number;
  acceptedCount: number;
  accept409Count: number;
  acceptDurationMs: number;
  acceptRatePerSec: number;
  completedCount: number;
  failedCount: number;
  totalWallMs: number;
  completedPerSec: number;
  avgQueueWaitMs: number;
  avgProcessingMs: number;
  p95ProcessingMs: number;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

async function runAt(concurrency: number, jobCount: number, imageBuffer: Buffer): Promise<RunResult> {
  const suffix = randomUUID().slice(0, 8);
  const storageDir = await mkdtemp(join(tmpdir(), "jobrelay-bench-"));
  const config: Config = {
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    PORT: 0,
    DATABASE_URL: process.env.DATABASE_URL ?? "postgres://jobrelay:jobrelay@localhost:5432/jobrelay",
    REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
    MAIN_QUEUE_NAME: `bench-main-${suffix}`,
    DEMO_QUEUE_NAME: `bench-demo-${suffix}`,
    MAX_UPLOAD_BYTES: 8_000_000,
    MAX_IMAGE_DIMENSION_PX: 6000,
    MAX_IMAGE_PIXELS: 30_000_000,
    MAX_JOB_ATTEMPTS: 3,
    BACKOFF_BASE_MS: 200,
    BACKOFF_MAX_MS: 2000,
    BACKOFF_JITTER: 0.2,
    WORKER_CONCURRENCY: concurrency,
    LOCK_DURATION_MS: 30_000,
    STALLED_INTERVAL_MS: 5000,
    MAX_STALLED_COUNT: 1,
    OUTBOX_SWEEP_INTERVAL_MS: 200,
    OUTBOX_BATCH_SIZE: 100,
    WORKER_HEARTBEAT_INTERVAL_MS: 5000,
    WORKER_OFFLINE_THRESHOLD_MS: 10_000,
    STORAGE_DIR: storageDir,
    RETENTION_MINUTES: 60,
    RETENTION_SWEEP_INTERVAL_MS: 3_600_000,
    DEMO_ENABLED: false,
    DEMO_WORKER_COUNT: 0,
    WORKER_KIND: "main",
    WORKER_ID_OVERRIDE: undefined,
  };

  const pool = new Pool({ connectionString: config.DATABASE_URL, max: 10 });
  pool.on("error", () => {});
  await runMigrations(pool);
  const storagePaths = resolveStoragePaths(config.STORAGE_DIR);
  await ensureStorageDirs(storagePaths);

  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2 });
  redis.on("error", () => {});
  const queues = createQueueSet(config, redis);
  const dispatcher: DispatcherDeps = { pool, queues, logger, batchSize: config.OUTBOX_BATCH_SIZE };
  const sweeper = startOutboxSweeper(dispatcher, config.OUTBOX_SWEEP_INTERVAL_MS);

  const workerConnection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  workerConnection.on("error", () => {});
  const processor = makeProcessor({ pool, logger, workerId: `bench-${suffix}`, storagePaths, imageLimits: { maxUploadBytes: config.MAX_UPLOAD_BYTES, maxDimensionPx: config.MAX_IMAGE_DIMENSION_PX, maxPixels: config.MAX_IMAGE_PIXELS } });
  const worker = new Worker<JobQueueData>(config.MAIN_QUEUE_NAME, processor, {
    connection: workerConnection,
    concurrency,
    lockDuration: config.LOCK_DURATION_MS,
    stalledInterval: config.STALLED_INTERVAL_MS,
    maxStalledCount: config.MAX_STALLED_COUNT,
    settings: { backoffStrategy: makeBackoffStrategy(config) },
  });
  worker.on("error", () => {});

  const app = createApp({ pool, redis, dispatcher, storagePaths, config, logger, publicDir: storageDir });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;

  // --- the actual measured run -------------------------------------------
  const acceptStart = Date.now();
  const submissions = await Promise.all(
    Array.from({ length: jobCount }, async () => {
      const form = new FormData();
      form.append("image", new Blob([new Uint8Array(imageBuffer)], { type: "image/jpeg" }), "bench.jpg");
      const res = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
        method: "POST",
        headers: { "Idempotency-Key": randomUUID() },
        body: form,
      });
      const body = (await res.json()) as { job?: { id: string } };
      return { status: res.status, jobId: body.job?.id };
    }),
  );
  const acceptDurationMs = Date.now() - acceptStart;
  const accepted = submissions.filter((s) => s.status === 202 && s.jobId);
  const accept409 = submissions.filter((s) => s.status === 409);

  const deadline = Date.now() + 120_000;
  const jobIds = accepted.map((s) => s.jobId!) as string[];
  let rows: Array<{ status: string; created_at: Date; started_at: Date | null; finished_at: Date | null }> = [];
  for (;;) {
    const { rows: current } = await pool.query<{ status: string; created_at: Date; started_at: Date | null; finished_at: Date | null }>(
      `SELECT status, created_at, started_at, finished_at FROM jobs WHERE id = ANY($1)`,
      [jobIds],
    );
    rows = current;
    const stillGoing = current.filter((r) => r.status !== "succeeded" && r.status !== "failed").length;
    if (stillGoing === 0 || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  const totalWallMs = Date.now() - acceptStart;

  const completed = rows.filter((r) => r.status === "succeeded");
  const failed = rows.filter((r) => r.status === "failed");
  const queueWaits = rows.filter((r) => r.started_at).map((r) => r.started_at!.getTime() - r.created_at.getTime());
  const processingTimes = completed.filter((r) => r.finished_at && r.started_at).map((r) => r.finished_at!.getTime() - r.started_at!.getTime());

  await worker.close(true).catch(() => {});
  workerConnection.disconnect();
  sweeper.stop();
  await queues.main.obliterate({ force: true }).catch(() => {});
  await queues.demo.obliterate({ force: true }).catch(() => {});
  await queues.main.close();
  await queues.demo.close();
  redis.disconnect();
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
  await rm(storageDir, { recursive: true, force: true }).catch(() => {});

  return {
    concurrency,
    jobs: jobCount,
    acceptedCount: accepted.length,
    accept409Count: accept409.length,
    acceptDurationMs,
    acceptRatePerSec: accepted.length / (acceptDurationMs / 1000),
    completedCount: completed.length,
    failedCount: failed.length,
    totalWallMs,
    completedPerSec: completed.length / (totalWallMs / 1000),
    avgQueueWaitMs: queueWaits.length ? queueWaits.reduce((a, b) => a + b, 0) / queueWaits.length : 0,
    avgProcessingMs: processingTimes.length ? processingTimes.reduce((a, b) => a + b, 0) / processingTimes.length : 0,
    p95ProcessingMs: percentile(processingTimes, 95),
  };
}

function fmtTable(results: RunResult[]): string {
  const header = "| concurrency | jobs | accepted | 409s | accept req/s | completed | failed | completed jobs/s | avg queue wait (ms) | avg processing (ms) | p95 processing (ms) |";
  const sep = "|---|---|---|---|---|---|---|---|---|---|---|";
  const rows = results.map(
    (r) =>
      `| ${r.concurrency} | ${r.jobs} | ${r.acceptedCount} | ${r.accept409Count} | ${r.acceptRatePerSec.toFixed(1)} | ${r.completedCount} | ${r.failedCount} | ${r.completedPerSec.toFixed(2)} | ${r.avgQueueWaitMs.toFixed(0)} | ${r.avgProcessingMs.toFixed(0)} | ${r.p95ProcessingMs.toFixed(0)} |`,
  );
  return [header, sep, ...rows].join("\n");
}

function dependencyVersions(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const names = ["bullmq", "ioredis", "pg", "sharp", "express"];
  return Object.fromEntries(names.map((n) => [n, pkg.dependencies[n]]));
}

async function main(): Promise<void> {
  const { jobs, concurrencies } = parseArgs();
  const imageBuffer = await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 130, g: 110, b: 90 } } }).jpeg({ quality: 85 }).toBuffer();

  console.log(`JobRelay benchmark: ${jobs} jobs per run, image payload ${imageBuffer.byteLength} bytes, concurrencies=[${concurrencies.join(", ")}]`);
  console.log("(this submits real HTTP requests and waits for real Postgres/Redis/worker processing -- it will take a while)\n");

  const results: RunResult[] = [];
  for (const c of concurrencies) {
    process.stdout.write(`running concurrency=${c} ... `);
    const result = await runAt(c, jobs, imageBuffer);
    results.push(result);
    console.log(`done (${result.completedCount}/${result.jobs} completed, ${result.completedPerSec.toFixed(2)} jobs/s)`);
  }

  const table = fmtTable(results);
  console.log("\n" + table);

  let dockerInfo = "unknown (docker not queried)";
  try {
    dockerInfo = execSync("docker --version", { encoding: "utf8" }).trim();
  } catch {
    /* ignore */
  }

  const report = `# JobRelay benchmark results

**Status: measured** -- run on ${new Date().toISOString()}.

## Environment

- OS: ${os.type()} ${os.release()} (${os.arch()})
- CPUs: ${os.cpus().length}x ${os.cpus()[0]?.model ?? "unknown"}
- Total memory: ${(os.totalmem() / 1e9).toFixed(1)} GB
- Node: ${process.version}
- Docker: ${dockerInfo}
- Dependency versions: ${JSON.stringify(dependencyVersions())}
- Image payload: ${imageBuffer.byteLength} bytes (1200x800 synthetic JPEG)
- Jobs per run: ${jobs}

## Results

${table}

## Reading this table

- **accept req/s**: how fast the API durably accepts submissions (Postgres commit + 202 response) -- this is independent of how fast jobs actually get processed, which is the whole point of decoupling submission from execution with a queue.
- **completed jobs/s**: wall-clock throughput from "first request sent" to "last job reached succeeded/failed", including the submission burst itself.
- **avg queue wait**: time between a job's row being created and a worker actually starting it (started_at - created_at).
- **avg / p95 processing**: time a worker spent running the job once it started (finished_at - started_at).

## Limitations of this benchmark

- Single machine, Postgres/Redis/API/worker all local -- no network latency between components, which a real deployment would have.
- All jobs use the same synthetic 1200x800 image; real-world payload size/complexity varies and would shift processing time.
- Concurrency is varied on a single worker process; this does not measure scaling *across* multiple worker processes/machines.
`;

  await writeFile(new URL("./RESULTS.md", import.meta.url), report, "utf8");
  console.log("\nWrote bench/RESULTS.md");
}

main().catch((err) => {
  console.error("benchmark failed:", err);
  process.exitCode = 1;
});
