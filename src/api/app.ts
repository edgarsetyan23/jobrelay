import type { IncomingMessage } from "node:http";
import express, { type Express } from "express";
import { pinoHttp } from "pino-http";
import type { Pool } from "pg";
import type { Redis } from "ioredis";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { DispatcherDeps } from "../outbox/dispatcher.js";
import type { StoragePaths } from "../storage/paths.js";
import type { DemoWorkerManager } from "./demoWorkerManager.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { healthRouter } from "./routes/health.js";
import { jobsRouter } from "./routes/jobs.js";
import { demoRouter } from "./routes/demo.js";
import { workersRouter } from "./routes/workers.js";
import { filesRouter } from "./routes/files.js";

export interface AppDeps {
  pool: Pool;
  redis: Redis;
  dispatcher: DispatcherDeps;
  storagePaths: StoragePaths;
  config: Config;
  logger: Logger;
  demoWorkers?: DemoWorkerManager;
  publicDir: string;
}

/**
 * No authentication anywhere in this app -- it is a local, single-tenant demo
 * meant to be run on your own machine and never exposed publicly. See
 * README.md "Security" for why, and what a real deployment would need
 * instead.
 */
export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");

  // The frontend polls /api/jobs, /api/workers, /api/config, and thumbnail
  // files every ~1.5s -- logging each of those would drown out the
  // meaningful, one-off events (job submitted, worker heartbeat gone stale,
  // etc.) that make the terminal useful during a live demo.
  const isPolledEndpoint = (url: string | undefined) => !!url && (url.startsWith("/api/jobs") || url.startsWith("/api/workers") || url.startsWith("/api/config") || url.startsWith("/files/") || url === "/healthz" || url === "/readyz");
  app.use(
    pinoHttp({
      logger: deps.logger,
      autoLogging: { ignore: (req: IncomingMessage) => req.method === "GET" && isPolledEndpoint(req.url) },
    }),
  );

  app.use(healthRouter({ pool: deps.pool, redis: deps.redis, demoEnabled: deps.config.DEMO_ENABLED }));
  app.use(express.json({ limit: "100kb" }));

  app.use(jobsRouter({ pool: deps.pool, dispatcher: deps.dispatcher, storagePaths: deps.storagePaths, maxJobAttempts: deps.config.MAX_JOB_ATTEMPTS, maxUploadBytes: deps.config.MAX_UPLOAD_BYTES }));
  app.use(workersRouter({ pool: deps.pool, offlineThresholdMs: deps.config.WORKER_OFFLINE_THRESHOLD_MS }));
  app.use(filesRouter({ storagePaths: deps.storagePaths }));

  if (deps.config.DEMO_ENABLED && deps.demoWorkers) {
    app.use(
      demoRouter({
        pool: deps.pool,
        dispatcher: deps.dispatcher,
        storagePaths: deps.storagePaths,
        maxJobAttempts: deps.config.MAX_JOB_ATTEMPTS,
        maxUploadBytes: deps.config.MAX_UPLOAD_BYTES,
        demoWorkers: deps.demoWorkers,
      }),
    );
  }

  // The single-screen frontend. Static files (index.html, app.js, styles.css,
  // sample.jpg) live in publicDir and are served as-is.
  app.use(express.static(deps.publicDir));

  app.use(errorHandler(deps.logger));

  return app;
}
