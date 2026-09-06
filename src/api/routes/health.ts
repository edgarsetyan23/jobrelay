import { Router } from "express";
import type { Pool } from "pg";
import type { Redis } from "ioredis";
import { metrics } from "../../metrics/metrics.js";

export interface HealthDeps {
  pool: Pool;
  redis: Redis;
  demoEnabled: boolean;
}

export function healthRouter(deps: HealthDeps): Router {
  const router = Router();

  // Liveness: the process is up and able to handle HTTP. No dependency
  // checks -- a container orchestrator uses this to decide whether to
  // restart the process, and restarting won't fix a database outage.
  router.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  // Readiness: can this instance actually serve traffic right now? Checks
  // both dependencies with a short timeout each; an orchestrator uses this
  // to decide whether to route traffic here.
  router.get("/readyz", async (_req, res) => {
    const checks: Record<string, "ok" | "error"> = { database: "error", redis: "error" };

    const dbCheck = deps.pool
      .query("SELECT 1")
      .then(() => {
        checks.database = "ok";
      })
      .catch(() => {});

    const redisCheck = deps.redis
      .ping()
      .then(() => {
        checks.redis = "ok";
      })
      .catch(() => {});

    await Promise.all([dbCheck, redisCheck]);

    const ready = checks.database === "ok" && checks.redis === "ok";
    res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready", checks });
  });

  // Tells the static frontend whether to show the demonstration panel at
  // all -- the panel's own endpoints (routes/demo.ts) are simply not
  // mounted when this is false, so this is just what lets the page hide a
  // button that would otherwise 404.
  router.get("/api/config", (_req, res) => {
    res.status(200).json({ demoEnabled: deps.demoEnabled });
  });

  // Simple status endpoint (spec: "a simple status endpoint or CLI is
  // sufficient"). See also `npm run cli:status` for a terminal equivalent.
  router.get("/stats", async (_req, res) => {
    const { rows } = await deps.pool.query<{ status: string; count: string }>("SELECT status, count(*) AS count FROM jobs GROUP BY status");
    const jobCountsByStatus: Record<string, number> = {};
    for (const row of rows) jobCountsByStatus[row.status] = Number(row.count);

    res.status(200).json({
      process: "api",
      jobCountsByStatus,
      ...metrics.snapshot(),
    });
  });

  return router;
}
