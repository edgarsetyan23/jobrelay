import { Router } from "express";
import { FaultSpecSchema } from "../../faults/inject.js";
import { submitImageJob, type SubmitImageJobDeps } from "../submitImageJob.js";
import { createUploadMiddleware } from "../upload.js";
import { serializeJob } from "./jobs.js";
import { HttpError } from "../middleware/errorHandler.js";
import type { DemoWorkerManager } from "../demoWorkerManager.js";

export interface DemoRouterDeps extends SubmitImageJobDeps {
  maxUploadBytes: number;
  demoWorkers: DemoWorkerManager;
}

/**
 * Everything in this router is the isolated failure-demonstration surface:
 * jobs submitted here always go to the demo queue (never the main queue a
 * normal visitor's upload uses), may carry a fault spec, and the only
 * processes an operator can stop through this API are the demo workers this
 * process itself spawned. See docs/ARCHITECTURE.md "The demonstration panel".
 */
export function demoRouter(deps: DemoRouterDeps): Router {
  const router = Router();
  const upload = createUploadMiddleware(deps.maxUploadBytes);

  router.post("/api/demo/jobs", upload, async (req, res, next) => {
    try {
      let fault;
      if (typeof req.body?.fault === "string" && req.body.fault.length > 0) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(req.body.fault);
        } catch {
          throw new HttpError(400, "INVALID_FAULT_SPEC", "fault field must be valid JSON");
        }
        fault = FaultSpecSchema.parse(parsed);
      }

      const outcome = await submitImageJob(deps, {
        idempotencyKey: req.header("idempotency-key") ?? undefined,
        file: req.file ? { buffer: req.file.buffer, originalname: req.file.originalname } : undefined,
        isDemo: true,
        fault,
      });
      res.status(outcome.created ? 202 : outcome.job.status === "succeeded" || outcome.job.status === "failed" ? 200 : 202).json({
        job: serializeJob(outcome.job),
        replayed: !outcome.created,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/api/demo/workers/:id/stop", (req, res) => {
    const id = req.params.id!;
    const stopped = deps.demoWorkers.stop(id);
    if (!stopped) {
      res.status(404).json({ error: { code: "DEMO_WORKER_NOT_FOUND", message: `no running demo worker with id ${id}` } });
      return;
    }
    res.status(200).json({ stopped: true, workerId: id });
  });

  return router;
}
