import { Router } from "express";
import { thumbnailPathFor, type StoragePaths } from "../../storage/paths.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_LABELS = new Set(["small", "medium", "large"]);

export interface FilesRouterDeps {
  storagePaths: StoragePaths;
}

/** jobId and label are both validated against fixed shapes before ever touching the filesystem -- no user-controlled path segments reach thumbnailPathFor. */
export function filesRouter(deps: FilesRouterDeps): Router {
  const router = Router();

  router.get("/files/results/:jobId/:filename", (req, res) => {
    const { jobId, filename } = req.params;
    const label = filename?.endsWith(".jpg") ? filename.slice(0, -4) : undefined;
    if (!jobId || !UUID_RE.test(jobId) || !label || !VALID_LABELS.has(label)) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "no such result file" } });
      return;
    }
    const path = thumbnailPathFor(deps.storagePaths, jobId, label);
    res.sendFile(path, (err) => {
      if (err) {
        // Most commonly ENOENT: the retention sweep already deleted it.
        res.status(404).json({ error: { code: "RESULT_EXPIRED_OR_NOT_FOUND", message: "this result is no longer available (it may have expired, or the job hasn't finished yet)" } });
      }
    });
  });

  return router;
}
