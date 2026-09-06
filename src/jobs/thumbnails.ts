// The one real job type JobRelay's workshop performs: take a small JPEG,
// PNG, or WebP image and produce three gallery thumbnails. Deliberately
// narrow scope, same spirit as the rest of this project -- no arbitrary
// image transforms, no remote fetches, just resizing bytes the visitor
// already uploaded.
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import sharp from "sharp";

export const ACCEPTED_FORMATS = ["jpeg", "png", "webp"] as const;
export type AcceptedFormat = (typeof ACCEPTED_FORMATS)[number];

export const THUMBNAIL_SIZES = [
  { label: "small", maxDimension: 150 },
  { label: "medium", maxDimension: 400 },
  { label: "large", maxDimension: 800 },
] as const;

/** Thrown for input that will never succeed no matter how many times it is retried. */
export class ValidationError extends Error {
  readonly name = "ValidationError";
}

export interface ImageLimits {
  maxUploadBytes: number;
  maxDimensionPx: number;
  maxPixels: number;
}

export interface ImageMetadata {
  format: AcceptedFormat;
  width: number;
  height: number;
  fileSizeBytes: number;
}

/**
 * Sniffs and validates an image buffer against the bounded limits. Reading
 * metadata with sharp only parses the file header, not the full decoded
 * raster -- cheap enough to do before committing to generating thumbnails,
 * and this is what stops a "6000x6000 PNG that's really a 4-gigapixel
 * decompression bomb" from ever reaching .resize().
 */
export async function validateImageBuffer(buffer: Buffer, limits: ImageLimits): Promise<ImageMetadata> {
  if (buffer.byteLength > limits.maxUploadBytes) {
    throw new ValidationError(`upload is ${buffer.byteLength} bytes, exceeding the limit of ${limits.maxUploadBytes} bytes`);
  }

  let metadata;
  try {
    metadata = await sharp(buffer, { failOn: "error" }).metadata();
  } catch {
    throw new ValidationError("file is not a readable image (or is corrupt)");
  }

  const format = metadata.format;
  if (!format || !(ACCEPTED_FORMATS as readonly string[]).includes(format)) {
    throw new ValidationError(`unsupported image format "${format ?? "unknown"}" -- only jpeg, png, and webp are accepted`);
  }

  const { width, height } = metadata;
  if (!width || !height) {
    throw new ValidationError("image is missing width/height metadata");
  }
  if (width > limits.maxDimensionPx || height > limits.maxDimensionPx) {
    throw new ValidationError(`image is ${width}x${height}px, exceeding the per-side limit of ${limits.maxDimensionPx}px`);
  }
  if (width * height > limits.maxPixels) {
    throw new ValidationError(`image has ${width * height} pixels, exceeding the limit of ${limits.maxPixels}`);
  }

  return { format: format as AcceptedFormat, width, height, fileSizeBytes: buffer.byteLength };
}

export interface ThumbnailOutput {
  label: string;
  width: number;
  height: number;
  fileSizeBytes: number;
  path: string;
}

/**
 * Regenerates all three thumbnails from the original file on disk. Pure
 * function of (source bytes, output paths) -- safe to re-run any number of
 * times (retries, duplicate delivery): it just overwrites the same files
 * with the same content.
 */
export interface GenerateThumbnailsResult {
  metadata: ImageMetadata;
  thumbnails: ThumbnailOutput[];
}

export async function generateThumbnails(sourcePath: string, outputPathFor: (label: string) => string, limits: ImageLimits): Promise<GenerateThumbnailsResult> {
  const buffer = await readFile(sourcePath);
  // The one and only place image format/dimensions are authoritatively
  // validated, against the actual bytes on disk -- mirrors the original CSV
  // job's "the worker validates the data" design. A bad file throws
  // ValidationError here and never gets this far again (see processor.ts).
  const metadata = await validateImageBuffer(buffer, limits);

  const outputs: ThumbnailOutput[] = [];
  for (const size of THUMBNAIL_SIZES) {
    const outPath = outputPathFor(size.label);
    await mkdir(dirname(outPath), { recursive: true });
    const image = sharp(buffer).rotate(); // auto-orient using EXIF, then strip it
    await image.resize(size.maxDimension, size.maxDimension, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82 }).toFile(outPath);
    const resized = await sharp(outPath).metadata();
    const stats = await stat(outPath);
    outputs.push({
      label: size.label,
      width: resized.width ?? 0,
      height: resized.height ?? 0,
      fileSizeBytes: stats.size,
      path: outPath,
    });
  }
  return { metadata, thumbnails: outputs };
}
