/**
 * Produces a short, display-only label from a client-supplied filename. This
 * value is only ever shown in the UI / stored in job.payload -- it never
 * touches the filesystem (see src/storage/paths.ts, which names files after
 * the server-generated job id instead).
 */
export function sanitizeFilenameForDisplay(rawName: string | undefined): string {
  if (!rawName) return "upload";
  const base = rawName.slice(Math.max(rawName.lastIndexOf("/"), rawName.lastIndexOf("\\")) + 1);
  const cleaned = base.replace(/[^\w.\- \p{L}\p{M}]/gu, "").trim();
  // A UTF-16 slice can leave the first half of a supplementary character.
  return (cleaned || "upload").slice(0, 120).replace(/[\uD800-\uDBFF]$/, "").trimEnd();
}
