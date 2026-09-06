import multer from "multer";

/** Memory storage: files are small (bounded by maxBytes) and short-lived -- we write them to disk ourselves right after, see submitImageJob.ts. */
export function createUploadMiddleware(maxBytes: number) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1 },
  }).single("image");
}
