import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { MulterError } from "multer";
import { IdempotencyConflictError } from "../../db/jobsRepo.js";
import type { Logger } from "../../logger.js";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function errorHandler(logger: Logger) {
  // Express identifies error-handling middleware by arity (4 params) -- keep the signature exact.
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    if (err instanceof IdempotencyConflictError) {
      res.status(409).json({
        error: {
          code: "IDEMPOTENCY_KEY_CONFLICT",
          message: err.message,
          existingJobId: err.existingJob.id,
        },
      });
      return;
    }
    if (err instanceof ZodError) {
      res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "request failed validation",
          issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      });
      return;
    }
    if (err && typeof err === "object" && "type" in err && (err as { type?: string }).type === "entity.too.large") {
      res.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: "request body exceeds the configured size limit" } });
      return;
    }
    if (err instanceof MulterError) {
      const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      res.status(status).json({ error: { code: `UPLOAD_${err.code}`, message: err.message } });
      return;
    }

    // Never log req.body/req.file here -- they may contain the raw uploaded
    // image or its bytes. The logger's redact config also covers this, but
    // we're explicit anyway.
    logger.error({ err, path: req.path, method: req.method }, "unhandled request error");
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "an unexpected error occurred" } });
  };
}
