// Bounded exponential backoff with jitter, implemented as a BullMQ custom
// backoff strategy (registered on the Worker via `settings.backoffStrategy`,
// selected per-job via `backoff: { type: "custom" }` when the job is added).
//
// BullMQ's built-in `exponential` backoff type does not support a hard cap,
// only a base delay and optional jitter fraction. We want a cap (retries
// should never wait longer than BACKOFF_MAX_MS) so we implement it ourselves:
// delay = min(base * 2^(attemptsMade-1), max), then +/- (delay * jitter).
import type { Config } from "../config.js";

export type BackoffStrategy = (attemptsMade: number) => number;

export function makeBackoffStrategy(config: Pick<Config, "BACKOFF_BASE_MS" | "BACKOFF_MAX_MS" | "BACKOFF_JITTER">): BackoffStrategy {
  return (attemptsMade: number): number => {
    const exponential = config.BACKOFF_BASE_MS * 2 ** Math.max(0, attemptsMade - 1);
    const capped = Math.min(exponential, config.BACKOFF_MAX_MS);
    const jitterRange = capped * config.BACKOFF_JITTER;
    const jitter = (Math.random() * 2 - 1) * jitterRange;
    return Math.max(0, Math.round(capped + jitter));
  };
}
