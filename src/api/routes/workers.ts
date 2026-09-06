import { Router } from "express";
import type { Pool } from "pg";
import { listWorkers } from "../../db/jobsRepo.js";

export interface WorkersRouterDeps {
  pool: Pool;
  offlineThresholdMs: number;
}

/** "offline" is never a status a worker writes about itself -- it's inferred here from a stale heartbeat, which is the only honest way to represent a process that has actually crashed. */
export function workersRouter(deps: WorkersRouterDeps): Router {
  const router = Router();

  router.get("/api/workers", async (_req, res, next) => {
    try {
      const rows = await listWorkers(deps.pool);
      const now = Date.now();
      const workers = rows.map((w) => {
        const staleMs = now - w.last_heartbeat_at.getTime();
        const status = staleMs > deps.offlineThresholdMs ? "offline" : w.status;
        return {
          id: w.id,
          kind: w.kind,
          status,
          currentJobId: w.current_job_id,
          startedAt: w.started_at,
          lastHeartbeatAt: w.last_heartbeat_at,
        };
      });
      res.status(200).json({ workers });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
