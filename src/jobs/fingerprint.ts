// Idempotency fingerprint: sha256 of a canonical JSON encoding of the
// payload (object keys sorted recursively, so key order in the client's
// request body never affects the fingerprint). Two submissions with the same
// idempotency key are "the same payload" iff their fingerprints match.
import { createHash } from "node:crypto";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const sortedKeys = Object.keys(value as Record<string, unknown>).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      result[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

export function computeFingerprint(payload: unknown): string {
  const canonical = JSON.stringify(canonicalize(payload));
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
