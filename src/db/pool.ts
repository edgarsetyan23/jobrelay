import { Pool } from "pg";
import type { Config } from "../config.js";

export function createPool(config: Pick<Config, "DATABASE_URL">): Pool {
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5000,
  });
  // node-postgres requires an 'error' listener on the pool -- an idle
  // client's connection dropping is otherwise an uncaught exception that
  // crashes the process, not just a failed query.
  pool.on("error", () => {});
  return pool;
}
