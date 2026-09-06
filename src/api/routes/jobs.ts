import { Router } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { getJobById, listJobAttempts, listJobs, type JobRow, type JobStatus } from "../../db/jobsRepo.js";
import { submitImageJob, type SubmitImageJobDeps } from "../submitImageJob.js";
import { createUploadMiddleware } from "../upload.js";
import { HttpError } from "../middleware/errorHandler.js";

const JOB_STATUSES: JobStatus[] = ["queued", "running", "retrying", "succeeded", "failed"];

const ListQuerySchema = z.object({
  status: z.enum(JOB_STATUSES as [JobStatus, ...JobStatus[]]).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export function serializeJob(job: JobRow) {
  return {
    id: job.id,
    jobType: job.job_type,
    status: job.status,
    isDemo: job.is_demo,
    attempts: job.attempts,
    maxAttempts: job.max_attempts,
    result: job.result,
    error: job.error,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
  };
}

/** A job whose current status is still in-flight gets 202; a terminal replay gets 200 (there's a final answer to hand back right now). */
function statusCodeFor(job: JobRow, justCreated: boolean): number {
  if (justCreated) return 202;
  return job.status === "succeeded" || job.status === "failed" ? 200 : 202;
}

export interface JobsRouterDeps extends SubmitImageJobDeps {
  pool: Pool;
  maxUploadBytes: number;
}

export function jobsRouter(deps: JobsRouterDeps): Router {
  const router = Router();
  const upload = createUploadMiddleware(deps.maxUploadBytes);

  // The normal, unauthenticated visitor flow: upload an image, get a ticket
  // back. Always routed to the main queue/main worker(s) -- never carries a
  // fault spec (see submitImageJob.ts and routes/demo.ts for the isolated
  // demo-only equivalent).
  router.post("/api/jobs", upload, async (req, res, next) => {
    try {
      const outcome = await submitImageJob(deps, {
        idempotencyKey: req.header("idempotency-key") ?? undefined,
        file: req.file ? { buffer: req.file.buffer, originalname: req.file.originalname } : undefined,
        isDemo: false,
      });
      res.status(statusCodeFor(outcome.job, outcome.created)).json({ job: serializeJob(outcome.job), replayed: !outcome.created });
    } catch (err) {
      next(err);
    }
  });

  router.get("/api/jobs/:id", async (req, res, next) => {
    try {
      const job = await getJobById(deps.pool, req.params.id!);
      if (!job) throw new HttpError(404, "JOB_NOT_FOUND", `no job with id ${req.params.id}`);
      res.status(200).json({ job: serializeJob(job) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/api/jobs/:id/attempts", async (req, res, next) => {
    try {
      const job = await getJobById(deps.pool, req.params.id!);
      if (!job) throw new HttpError(404, "JOB_NOT_FOUND", `no job with id ${req.params.id}`);
      const attempts = await listJobAttempts(deps.pool, job.id);
      res.status(200).json({ jobId: job.id, attempts });
    } catch (err) {
      next(err);
    }
  });

  router.get("/api/jobs", async (req, res, next) => {
    try {
      const query = ListQuerySchema.parse(req.query);
      const result = await listJobs(deps.pool, query);
      res.status(200).json({ jobs: result.jobs.map(serializeJob), nextCursor: result.nextCursor });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
