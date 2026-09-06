import { loadConfig } from "../config.js";
import { logger } from "../logger.js";
import { createPool } from "../db/pool.js";
import { runMigrations } from "../db/migrate.js";
import { deleteWorkersByKind } from "../db/jobsRepo.js";
import { createApiRedisConnection } from "../queue/connection.js";
import { createQueueSet } from "../queue/queue.js";
import { startOutboxSweeper } from "../outbox/dispatcher.js";
import { resolveStoragePaths, ensureStorageDirs } from "../storage/paths.js";
import { startRetentionSweeper } from "../cleanup/retention.js";
import { DemoWorkerManager } from "./demoWorkerManager.js";
import { createApp } from "./app.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "..", "public");

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);
  const redis = createApiRedisConnection(config);
  const queues = createQueueSet(config, redis);
  const storagePaths = resolveStoragePaths(config.STORAGE_DIR);
  await ensureStorageDirs(storagePaths);

  logger.info("running database migrations");
  await runMigrations(pool);
  // Demo workers are re-spawned fresh every time the API starts; clear out
  // whatever rows a previous run left behind so the worker-station board
  // doesn't show phantom "offline" entries.
  await deleteWorkersByKind(pool, "demo");

  const dispatcher = { pool, queues, logger, batchSize: config.OUTBOX_BATCH_SIZE };
  const sweeper = startOutboxSweeper(dispatcher, config.OUTBOX_SWEEP_INTERVAL_MS);
  const retentionSweeper = startRetentionSweeper({ pool, storagePaths, logger, retentionMinutes: config.RETENTION_MINUTES }, config.RETENTION_SWEEP_INTERVAL_MS);

  let demoWorkers: DemoWorkerManager | undefined;
  if (config.DEMO_ENABLED) {
    demoWorkers = new DemoWorkerManager({
      count: config.DEMO_WORKER_COUNT,
      logger,
      env: process.env,
    });
    demoWorkers.start();
    logger.info({ count: config.DEMO_WORKER_COUNT }, "demo worker pool started");
  }

  const app = createApp({ pool, redis, dispatcher, storagePaths, config, logger, demoWorkers, publicDir: PUBLIC_DIR });
  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT }, "jobrelay api listening");
  });

  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down api");
    sweeper.stop();
    retentionSweeper.stop();
    demoWorkers?.stopAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await queues.main.close();
    await queues.demo.close();
    redis.disconnect();
    await pool.end();
    logger.info("api shutdown complete");
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error({ err }, "fatal startup error");
  process.exit(1);
});
