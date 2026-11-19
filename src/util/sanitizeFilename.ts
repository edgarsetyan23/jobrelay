/**
 * Produces a short, display-only label from a client-supplied filename. This
 * value is only ever shown in the UI / stored in job.payload -- it never
 * touches the filesystem (see src/storage/paths.ts, which names files after
 * the server-generated job id instead).
 */
export function sanitizeFilenameForDisplay(rawName: string | undefined): string {
  if (!rawName) return "upload";
  const base = rawName.slice(Math.max(rawName.lastIndexOf("/"), rawName.lastIndexOf("\\")) + 1);
  const cleaned = base.replace(/[^\w.\- ]/g, "").trim();
  const label = cleaned.slice(0, 120).trimEnd();
  if (!label || label === "." || label === "..") return "upload";
  return label;
}
