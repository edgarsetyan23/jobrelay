// Structured logging (pino). Redact anything that could leak a credential or
// a visitor's uploaded file bytes -- job payloads/requests may carry image
// data or filenames and must never land in logs verbatim.
import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: ["req.headers.authorization", "config.DATABASE_URL", "config.REDIS_URL", "payload", "*.payload", "job.payload", "req.file", "req.body.image"],
    censor: "[redacted]",
  },
  transport: isDev
    ? {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname" },
      }
    : undefined,
});

export type Logger = typeof logger;
