// Shared submission path for both the normal upload endpoint and the demo
// panel's endpoint (see routes/jobs.ts and routes/demo.ts). The two callers
// differ only in `isDemo` and whether a fault spec is allowed through --
// everything else (idempotency, the outbox write, orphaned-file cleanup) is
// identical, which is exactly why it lives in one place instead of being
// copy-pasted with a chance to drift.
import { createHash, randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import type { Pool } from "pg";
import { createJobWithOutbox, IdempotencyConflictError, type CreateJobOutcome } from "../db/jobsRepo.js";
import { publishOnce, type DispatcherDeps } from "../outbox/dispatcher.js";
import { uploadPathFor, type StoragePaths } from "../storage/paths.js";
import { sanitizeFilenameForDisplay } from "../util/sanitizeFilename.js";
import type { FaultSpec } from "../faults/inject.js";
import type { ImageJobPayload } from "../worker/processor.js";
import { metrics } from "../metrics/metrics.js";
import { HttpError } from "./middleware/errorHandler.js";

const JOB_TYPE = "thumbnail" as const;

export interface SubmitImageJobDeps {
  pool: Pool;
  dispatcher: DispatcherDeps;
  storagePaths: StoragePaths;
  maxJobAttempts: number;
}

export interface SubmitImageJobInput {
  idempotencyKey: string | undefined;
  file: { buffer: Buffer; originalname: string } | undefined;
  isDemo: boolean;
  /** Only ever read when isDemo is true -- see src/faults/inject.ts. */
  fault?: FaultSpec;
}

export async function submitImageJob(deps: SubmitImageJobDeps, input: SubmitImageJobInput): Promise<CreateJobOutcome> {
  if (!input.idempotencyKey || input.idempotencyKey.length > 200) {
    throw new HttpError(400, "MISSING_IDEMPOTENCY_KEY", "Idempotency-Key header is required (max 200 chars)");
  }
  if (!input.file) {
    throw new HttpError(400, "MISSING_FILE", 'a file is required in the "image" field');
  }

  const id = randomUUID();
  const uploadPath = uploadPathFor(deps.storagePaths, id);
  await writeFile(uploadPath, input.file.buffer);

  const payload: ImageJobPayload = {
    originalFilename: sanitizeFilenameForDisplay(input.file.originalname),
    fileSizeBytes: input.file.buffer.length,
    // Hashing the actual bytes (not just filename + size) is what makes the
    // idempotency fingerprint below trustworthy: two different images that
    // happen to share a filename and byte count -- easy to construct by
    // accident or on purpose -- must not be treated as "the same request"
    // just because an idempotency key was reused.
    contentSha256: createHash("sha256").update(input.file.buffer).digest("hex"),
    ...(input.isDemo && input.fault ? { _fault: input.fault } : {}),
  };

  try {
    const outcome = await createJobWithOutbox(deps.pool, {
      id,
      jobType: JOB_TYPE,
      idempotencyKey: input.idempotencyKey,
      payload,
      maxAttempts: deps.maxJobAttempts,
      isDemo: input.isDemo,
    });

    if (!outcome.created) {
      // Someone else's submission (same idempotency key) won the race, or
      // this is a pure replay -- the file we just wrote under `id` is
      // orphaned since the authoritative job is a different id.
      await rm(uploadPath, { force: true }).catch(() => {});
    } else {
      metrics.recordAccepted();
      // Best-effort immediate publish so the common case has near-zero
      // queue latency. Not awaited: the response is gated on the Postgres
      // commit above, not on Redis being reachable -- if this fails (e.g.
      // Redis down), the outbox sweeper picks it up.
      publishOnce(deps.dispatcher).catch((err) => deps.dispatcher.logger.error({ err }, "immediate outbox publish failed"));
    }
    return outcome;
  } catch (err) {
    if (err instanceof IdempotencyConflictError) {
      metrics.recordRejected409();
    }
    await rm(uploadPath, { force: true }).catch(() => {});
    throw err;
  }
}
