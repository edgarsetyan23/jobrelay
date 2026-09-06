// All configuration is validated once, on startup, with zod. If anything is
// missing or malformed the process exits immediately with a clear message --
// we never limp along with a half-valid config.
import "dotenv/config";
import { z } from "zod";

const boolFromEnv = (defaultValue: "true" | "false") =>
  z
    .enum(["true", "false"])
    .optional()
    .default(defaultValue)
    .transform((v) => v === "true");

const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.url("DATABASE_URL must be a valid postgres:// connection string"),
  REDIS_URL: z.url("REDIS_URL must be a valid redis:// connection string"),
  MAIN_QUEUE_NAME: z.string().min(1).default("jobrelay-jobs"),
  DEMO_QUEUE_NAME: z.string().min(1).default("jobrelay-demo-jobs"),

  // --- Upload / image job limits ---
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(8_000_000), // 8 MB
  MAX_IMAGE_DIMENSION_PX: z.coerce.number().int().positive().default(6000), // per side
  MAX_IMAGE_PIXELS: z.coerce.number().int().positive().default(30_000_000), // guards decompression bombs

  // --- Retry / worker tuning (shared by main and demo workers) ---
  MAX_JOB_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  BACKOFF_BASE_MS: z.coerce.number().int().positive().default(500),
  BACKOFF_MAX_MS: z.coerce.number().int().positive().default(30_000),
  BACKOFF_JITTER: z.coerce.number().min(0).max(1).default(0.3),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),
  // Shorter than BullMQ's own usual defaults (30000/30000/1) on purpose: the
  // interactive "Stop this worker" demo needs recovery to be visible within
  // a few seconds, not half a minute. Still fully configurable -- a
  // production deployment processing longer-running jobs should raise
  // LOCK_DURATION_MS well above its typical job duration.
  LOCK_DURATION_MS: z.coerce.number().int().positive().default(8000),
  STALLED_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  MAX_STALLED_COUNT: z.coerce.number().int().min(1).default(2),

  // --- Outbox dispatcher (runs inside the API process) ---
  OUTBOX_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().default(50),

  // --- Worker heartbeat / worker-station display ---
  WORKER_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  WORKER_OFFLINE_THRESHOLD_MS: z.coerce.number().int().positive().default(3500),

  // --- File storage + retention ---
  STORAGE_DIR: z.string().min(1).default("./data"),
  RETENTION_MINUTES: z.coerce.number().int().positive().default(60),
  RETENTION_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),

  // --- The interactive demonstration panel ---
  // Spawns two isolated "demo" worker processes the API itself controls
  // (so "stop this worker" can only ever kill a process the API started,
  // dedicated to demo-flagged jobs -- never the main worker or anything
  // else). Set to false to run JobRelay as a plain thumbnail service with
  // no failure-injection surface at all.
  DEMO_ENABLED: boolFromEnv("true"),
  DEMO_WORKER_COUNT: z.coerce.number().int().min(1).max(4).default(2),

  // --- Worker process role (set via env by how the process is launched,
  //     not something an operator hand-edits in .env) ---
  WORKER_KIND: z.enum(["main", "demo"]).default("main"),
  WORKER_ID_OVERRIDE: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

let cached: Config | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    // Never log raw env values here -- only the field-level validation issues.
    const issues = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    // eslint-disable-next-line no-console
    console.error(`Invalid configuration:\n${issues}`);
    process.exit(1);
  }
  cached = result.data;
  return cached;
}

/** Test-only: clear the memoized config so a test can reload with different env vars. */
export function _resetConfigForTests(): void {
  cached = undefined;
}
