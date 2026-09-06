import { Router } from "express";
import type { Pool } from "pg";
import { getJobResultLocation } from "../../db/jobsRepo.js";
import { attemptThumbnailPathFor, type StoragePaths } from "../../storage/paths.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_LABELS = new Set(["small", "medium", "large"]);

export interface FilesRouterDeps {
  pool: Pool;
  storagePaths: StoragePaths;
}

/**
 * jobId and label are both validated against fixed shapes before ever
 * touching the filesystem -- no user-controlled path segments reach
 * attemptThumbnailPathFor. There is no fixed on-disk path for a job's
 * result any more (see storage/paths.ts "Attempt isolation"): every
 * request looks up `result_attempt_token` in Postgres first, and serves
 * only from that one attempt's directory. A job that hasn't succeeded yet,
 * or whose files have since been purged by retention, 404s the same way
 * either way -- this endpoint never reveals which case it is.
 */
export function filesRouter(deps: FilesRouterDeps): Router {
  const router = Router();

  router.get("/files/results/:jobId/:filename", async (req, res, next) => {
    try {
      const { jobId, filename } = req.params;
      const label = filename?.endsWith(".jpg") ? filename.slice(0, -4) : undefined;
      if (!jobId || !UUID_RE.test(jobId) || !label || !VALID_LABELS.has(label)) {
        res.status(404).json({ error: { code: "NOT_FOUND", message: "no such result file" } });
        return;
      }

      const location = await getJobResultLocation(deps.pool, jobId);
      if (!location || location.status !== "succeeded" || !location.resultAttemptToken) {
        // Covers: no such job, a job that hasn't succeeded (or failed
        // instead), and -- functionally identical from here -- a job whose
        // result was never published because every attempt lost its
        // ownership race (should never actually happen for a terminal
        // 'succeeded' job, but this endpoint treats it the same as
        // "not found" either way, not a 500).
        res.status(404).json({ error: { code: "RESULT_EXPIRED_OR_NOT_FOUND", message: "this result is no longer available (it may have expired, or the job hasn't finished yet)" } });
        return;
      }

      const path = attemptThumbnailPathFor(deps.storagePaths, jobId, location.resultAttemptToken, label);
      res.sendFile(path, (err) => {
        if (err) {
          // Most commonly ENOENT: the retention sweep already deleted it.
          res.status(404).json({ error: { code: "RESULT_EXPIRED_OR_NOT_FOUND", message: "this result is no longer available (it may have expired, or the job hasn't finished yet)" } });
        }
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
