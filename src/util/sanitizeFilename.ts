/**
 * Produces a short, display-only label from a client-supplied filename. This
 * value is only ever shown in the UI / stored in job.payload -- it never
 * touches the filesystem (see src/storage/paths.ts, which names files after
 * the server-generated job id instead).
 */
export function sanitizeFilenameForDisplay(rawName: string | undefined): string {
  if (!rawName) return "upload";
  const base = rawName.split(/[/\\]/).pop() ?? "upload";
  const cleaned = base.replace(/[^\w.\- ]/g, "").trim();
  return (cleaned || "upload").slice(0, 120);
}
