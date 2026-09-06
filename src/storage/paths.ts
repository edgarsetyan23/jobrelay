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

export function resultDirFor(paths: StoragePaths, jobId: string): string {
  return join(paths.resultsDir, jobId);
}

export function thumbnailPathFor(paths: StoragePaths, jobId: string, sizeLabel: string): string {
  return join(resultDirFor(paths, jobId), `${sizeLabel}.jpg`);
}

export async function deleteJobFiles(paths: StoragePaths, jobId: string): Promise<void> {
  await Promise.all([rm(resultDirFor(paths, jobId), { recursive: true, force: true }), rm(uploadPathFor(paths, jobId), { force: true })]);
}
