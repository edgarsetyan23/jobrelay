// Local-disk, shared-filesystem storage for uploaded originals and generated
// thumbnails. "Shared" here means: both the API process and every worker
// process (main + demo) point at the same STORAGE_DIR on the same machine,
// so a worker can read what the API saved. That's the simplest thing that
// works for a single-machine demo -- see docs/ARCHITECTURE.md "Storage" for
// what changes if the API and workers ever run on different machines.
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface StoragePaths {
  root: string;
  uploadsDir: string;
  resultsDir: string;
}

export function resolveStoragePaths(storageDir: string): StoragePaths {
  const root = resolve(storageDir);
  return {
    root,
    uploadsDir: join(root, "uploads"),
    resultsDir: join(root, "results"),
  };
}

export async function ensureStorageDirs(paths: StoragePaths): Promise<void> {
  await mkdir(paths.uploadsDir, { recursive: true });
  await mkdir(paths.resultsDir, { recursive: true });
}

// jobId is always a server-generated UUID (see db/jobsRepo.ts), never a
// client-controlled string, so joining it directly into a path is safe --
// there is no user input in these path segments. The original upload is
// always stored under a fixed, content-agnostic extension: we haven't
// validated the file's real format yet at upload time (that's the worker's
// job), so nothing about the on-disk name should depend on the client's
// claimed filename or Content-Type.
export function uploadPathFor(paths: StoragePaths, jobId: string): string {
  return join(paths.uploadsDir, `${jobId}.upload`);
}

// Kept only as a defensive cleanup target in deleteJobFiles below -- no
// current code path ever writes here. An earlier version of this project
// promoted a winning attempt's files into this shared, job-scoped
// directory; that promotion step was removed (see "Attempt isolation"
// immediately below) in favor of always serving directly from the winning
// attempt's own directory, so nothing should exist at this path in normal
// operation. It stays as a target purely so upgrading from that earlier
// on-disk layout, or any stray write, still gets cleaned up by retention.
export function resultDirFor(paths: StoragePaths, jobId: string): string {
  return join(paths.resultsDir, jobId);
}

export function thumbnailPathFor(paths: StoragePaths, jobId: string, sizeLabel: string): string {
  return join(resultDirFor(paths, jobId), `${sizeLabel}.jpg`);
}

// --- Attempt isolation -------------------------------------------------
// More than one attempt can be genuinely, concurrently in flight for the
// same job (see docs/FAILURE_SCENARIOS.md "Stale attempt" and
// src/db/migrations/003_attempt_ownership.sql): a worker whose lock merely
// expired keeps running and keeps generating thumbnails even after a
// recovering attempt has taken over. If every attempt wrote to (or was ever
// moved into) one shared, job-scoped directory, whichever one touched disk
// last -- promotion included -- could still race the other, regardless of
// which attempt the database says actually owns the job's result.
//
// So every attempt writes into, and *stays in*, its own directory, keyed by
// its running_token fencing token (never client-controlled -- see
// worker/processor.ts): STORAGE_DIR/results/_attempts/<jobId>/<token>/.
// There is no later move. Once `transitionToSucceeded` confirms an attempt
// won, that attempt's directory *is* the job's result, permanently (until
// retention purges it) -- `jobs.result_attempt_token`
// (004_result_attempt_token.sql) is the durable pointer to which directory
// that is, and the download endpoint (api/routes/files.ts) looks it up in
// Postgres on every request rather than assuming a fixed path. A losing (or
// errored) attempt's directory is deleted outright instead
// (`discardAttemptResult`), since nothing will ever point at it.
function attemptsRootFor(paths: StoragePaths, jobId: string): string {
  return join(paths.resultsDir, "_attempts", jobId);
}

export function attemptResultDirFor(paths: StoragePaths, jobId: string, attemptToken: string): string {
  return join(attemptsRootFor(paths, jobId), attemptToken);
}

export function attemptThumbnailPathFor(paths: StoragePaths, jobId: string, attemptToken: string, sizeLabel: string): string {
  return join(attemptResultDirFor(paths, jobId, attemptToken), `${sizeLabel}.jpg`);
}

/** Deletes a losing (or errored, or abandoned) attempt's own output directory. Safe to call even if the attempt never wrote anything. Never call this for the attempt whose token is (or might become) `jobs.result_attempt_token` -- that directory is the job's result and must live until retention purges it. */
export async function discardAttemptResult(paths: StoragePaths, jobId: string, attemptToken: string): Promise<void> {
  await rm(attemptResultDirFor(paths, jobId, attemptToken), { recursive: true, force: true });
}

/**
 * Deletes everything on disk for a job: the uploaded original and every
 * attempt directory that still exists under it -- the winning one
 * (`result_attempt_token`) included. Called only by the retention sweep,
 * once a terminal job is past `RETENTION_MINUTES`, which is what "preserve
 * winning files until retention expires" actually means: the winner's
 * directory is left untouched by everything else in this module and is
 * only ever removed here, on the same schedule as any other job's files.
 */
export async function deleteJobFiles(paths: StoragePaths, jobId: string): Promise<void> {
  await Promise.all([
    rm(resultDirFor(paths, jobId), { recursive: true, force: true }),
    rm(uploadPathFor(paths, jobId), { force: true }),
    rm(attemptsRootFor(paths, jobId), { recursive: true, force: true }),
  ]);
}
