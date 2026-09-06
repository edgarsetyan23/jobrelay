// `npm run cli:status [-- --status=failed --limit=10]`
// Talks directly to Postgres (not the HTTP API), so it works even if the API
// process is down -- useful for "is anything stuck" checks during the demo.
import { loadConfig } from "../config.js";
import { createPool } from "../db/pool.js";
import { listJobs, type JobStatus } from "../db/jobsRepo.js";

function parseArgs(argv: string[]): { status?: JobStatus; limit: number } {
  const args = Object.fromEntries(
    argv
      .filter((a) => a.startsWith("--"))
      .map((a) => {
        const [key, value] = a.slice(2).split("=");
        return [key, value ?? "true"];
      }),
  );
  return {
    status: args.status as JobStatus | undefined,
    limit: args.limit ? Number(args.limit) : 20,
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);

  const counts = await pool.query<{ status: string; count: string }>("SELECT status, count(*) AS count FROM jobs GROUP BY status ORDER BY status");
  console.log("Job counts by status:");
  for (const row of counts.rows) {
    console.log(`  ${row.status.padEnd(10)} ${row.count}`);
  }
  if (counts.rows.length === 0) {
    console.log("  (no jobs yet)");
  }

  const { status, limit } = parseArgs(process.argv.slice(2));
  const { jobs } = await listJobs(pool, { status, limit });

  console.log(`\nMost recent ${jobs.length} job(s)${status ? ` with status=${status}` : ""}:`);
  console.log("  id                                   status     attempts  created_at");
  for (const job of jobs) {
    console.log(`  ${job.id}  ${job.status.padEnd(9)}  ${String(job.attempts).padEnd(8)}  ${job.created_at.toISOString()}`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error("cli:status failed:", err);
  process.exitCode = 1;
});
