import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateThumbnails, validateImageBuffer, ValidationError, THUMBNAIL_SIZES } from "../../src/jobs/thumbnails.js";

const limits = { maxUploadBytes: 5_000_000, maxDimensionPx: 2000, maxPixels: 4_000_000 };

async function makeJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 100, b: 50 } } })
    .jpeg()
    .toBuffer();
}

describe("validateImageBuffer", () => {
  it("accepts a well-formed jpeg within limits", async () => {
    const buffer = await makeJpeg(100, 80);
    const meta = await validateImageBuffer(buffer, limits);
    expect(meta).toEqual({ format: "jpeg", width: 100, height: 80, fileSizeBytes: buffer.byteLength });
  });

  it("accepts png and webp", async () => {
    const png = await sharp({ create: { width: 50, height: 50, channels: 3, background: "red" } }).png().toBuffer();
    const webp = await sharp({ create: { width: 50, height: 50, channels: 3, background: "red" } }).webp().toBuffer();
    expect((await validateImageBuffer(png, limits)).format).toBe("png");
    expect((await validateImageBuffer(webp, limits)).format).toBe("webp");
  });

  it("rejects a corrupt / non-image buffer", async () => {
    await expect(validateImageBuffer(Buffer.from("not an image"), limits)).rejects.toThrow(ValidationError);
  });

  it("rejects an upload exceeding the byte-size limit", async () => {
    const buffer = await makeJpeg(100, 80);
    await expect(validateImageBuffer(buffer, { ...limits, maxUploadBytes: 10 })).rejects.toThrow(ValidationError);
  });

  it("rejects an image exceeding the per-side dimension limit", async () => {
    const buffer = await makeJpeg(3000, 100);
    await expect(validateImageBuffer(buffer, { ...limits, maxDimensionPx: 2000 })).rejects.toThrow(ValidationError);
  });

  it("rejects an image exceeding the total-pixel limit", async () => {
    const buffer = await makeJpeg(1900, 1900); // under per-side limit, over pixel limit
    await expect(validateImageBuffer(buffer, { ...limits, maxDimensionPx: 2000, maxPixels: 1_000_000 })).rejects.toThrow(ValidationError);
  });
});

describe("generateThumbnails", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jobrelay-thumb-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("produces one file per configured size, each fit within its box", async () => {
    const buffer = await makeJpeg(800, 400);
    const sourcePath = join(dir, "source.upload");
    await sharp(buffer).toFile(sourcePath);

    const { metadata, thumbnails } = await generateThumbnails(sourcePath, (label) => join(dir, `${label}.jpg`), limits);

    expect(metadata.width).toBe(800);
    expect(thumbnails).toHaveLength(THUMBNAIL_SIZES.length);
    for (const size of THUMBNAIL_SIZES) {
      const output = thumbnails.find((t) => t.label === size.label)!;
      expect(output.width).toBeLessThanOrEqual(size.maxDimension);
      expect(output.height).toBeLessThanOrEqual(size.maxDimension);
      expect(output.fileSizeBytes).toBeGreaterThan(0);
    }
  });

  it("is idempotent: re-running produces the same dimensions", async () => {
    const buffer = await makeJpeg(500, 500);
    const sourcePath = join(dir, "source.upload");
    await sharp(buffer).toFile(sourcePath);

    const first = await generateThumbnails(sourcePath, (label) => join(dir, `${label}.jpg`), limits);
    const second = await generateThumbnails(sourcePath, (label) => join(dir, `${label}.jpg`), limits);
    expect(second.thumbnails.map((t) => ({ label: t.label, width: t.width, height: t.height }))).toEqual(
      first.thumbnails.map((t) => ({ label: t.label, width: t.width, height: t.height })),
    );
  });

  it("propagates a validation failure for a corrupt source file", async () => {
    const sourcePath = join(dir, "bad.upload");
    await sharp({ create: { width: 10, height: 10, channels: 3, background: "blue" } }).jpeg().toFile(sourcePath);
    // Overwrite with garbage after creating a valid file, to isolate this
    // from filesystem setup concerns.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(sourcePath, "definitely not a jpeg");

    await expect(generateThumbnails(sourcePath, (label) => join(dir, `${label}.jpg`), limits)).rejects.toThrow(ValidationError);
  });
});
