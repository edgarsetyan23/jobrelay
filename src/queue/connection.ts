import { Redis } from "ioredis";
import type { Config } from "../config.js";

/**
 * BullMQ's Worker uses blocking Redis commands internally and *requires*
 * maxRetriesPerRequest: null on its connection (documented BullMQ
 * requirement) -- otherwise those blocking calls can be aborted mid-flight.
 */
export function createWorkerRedisConnection(config: Pick<Config, "REDIS_URL">): Redis {
  return new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
}

/**
 * The API process only ever issues non-blocking commands (Queue#add). We
 * want those to fail *fast* when Redis is unreachable -- rather than queueing
 * up behind ioredis's default long retry budget -- so the outbox dispatcher's
 * per-sweep publish attempt returns quickly and the sweep loop keeps ticking.
 * ioredis keeps retrying the underlying connection in the background
 * regardless (see retryStrategy), so once Redis comes back the very next
 * sweep succeeds.
 */
export function createApiRedisConnection(config: Pick<Config, "REDIS_URL">): Redis {
  return new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 2,
    connectTimeout: 3000,
    retryStrategy: (times: number) => Math.min(times * 200, 2000),
  });
}
