// Local-disk, shared-filesystem storage for uploaded originals and generated
// thumbnails. "Shared" here means: both the API process and every worker
// process (main + demo) point at the same STORAGE_DIR on the same machine,
// so a worker can read what the API saved. That's the simplest thing that
// works for a single-machine demo -- see docs/ARCHITECTURE.md "Storage" for
// what changes if the API and workers ever run on different machines.
import { mkdir, rename, rm } from "node:fs/promises";
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
// recovering attempt has taken over. If every attempt wrote to the same
// `resultDirFor(jobId)` directory, whichever one finished its disk writes
// last would silently overwrite the other's files -- regardless of which
// attempt the database says actually owns the job's result. Instead, every
// attempt writes into its own directory, keyed by its running_token fencing
// token (never client-controlled -- see worker/processor.ts), and only the
// attempt whose ownership-checked `transitionToSucceeded` call actually
// wins gets its directory promoted to the stable, publicly-served location.
function attemptsRootFor(paths: StoragePaths, jobId: string): string {
  return join(paths.resultsDir, "_attempts", jobId);
}

export function attemptResultDirFor(paths: StoragePaths, jobId: string, attemptToken: string): string {
  return join(attemptsRootFor(paths, jobId), attemptToken);
}

export function attemptThumbnailPathFor(paths: StoragePaths, jobId: string, attemptToken: string, sizeLabel: string): string {
  return join(attemptResultDirFor(paths, jobId, attemptToken), `${sizeLabel}.jpg`);
}

/**
 * Moves a winning attempt's already-generated thumbnails into the job's
 * canonical, publicly-served directory. Callers MUST only invoke this after
 * confirming the ownership-checked database transition actually succeeded
 * for this attempt -- see `processJob` in worker/processor.ts, which is the
 * only caller. `rename` on the same filesystem (both directories live under
 * the same STORAGE_DIR) is a single directory-entry swap, not a copy, so
 * there's no window where the destination holds a partial set of files.
 */
export async function promoteAttemptResult(paths: StoragePaths, jobId: string, attemptToken: string): Promise<void> {
  const from = attemptResultDirFor(paths, jobId, attemptToken);
  const to = resultDirFor(paths, jobId);
  // Defensive only: the canonical directory should never already exist --
  // exactly one attempt can ever win the ownership check for a given job --
  // but a leftover from some earlier, unexpected state must not make this
  // rename throw and strand a fully-generated result unpublished.
  await rm(to, { recursive: true, force: true });
  await rename(from, to);
}

/** Deletes a losing (or errored, or abandoned) attempt's own output directory. Safe to call even if the attempt never wrote anything, or already had its result promoted elsewhere. */
export async function discardAttemptResult(paths: StoragePaths, jobId: string, attemptToken: string): Promise<void> {
  await rm(attemptResultDirFor(paths, jobId, attemptToken), { recursive: true, force: true });
}

export async function deleteJobFiles(paths: StoragePaths, jobId: string): Promise<void> {
  await Promise.all([
    rm(resultDirFor(paths, jobId), { recursive: true, force: true }),
    rm(uploadPathFor(paths, jobId), { force: true }),
    // Belt-and-braces: normally no attempt directory outlives the job (each
    // one is promoted or discarded the moment it finishes), but this catches
    // anything left behind by a process that crashed between generating
    // files and resolving ownership.
    rm(attemptsRootFor(paths, jobId), { recursive: true, force: true }),
  ]);
}
