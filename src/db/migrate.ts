// Minimal migration runner: applies every .sql file in ./migrations, in
// filename order, that isn't already recorded in schema_migrations. No
// external migration framework -- this is small enough to read in one sitting.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { loadConfig } from "../config.js";
import { logger } from "../logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function runMigrations(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const dir = join(__dirname, "migrations");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const { rows } = await pool.query<{ filename: string }>("SELECT filename FROM schema_migrations");
  const applied = new Set(rows.map((r) => r.filename));

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(dir, file), "utf8");
    logger.info({ file }, "applying migration");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
  logger.info({ count: files.length }, "migrations up to date");
}

// Allow `npm run migrate` (and the compiled dist build) to run this directly.
const invokedDirectly = /migrate\.(ts|js)$/.test(process.argv[1] ?? "");
if (invokedDirectly) {
  const config = loadConfig();
  const pool = new Pool({ connectionString: config.DATABASE_URL });
  runMigrations(pool)
    .then(() => pool.end())
    .catch((err) => {
      logger.error({ err }, "migration failed");
      process.exitCode = 1;
      return pool.end();
    });
}
