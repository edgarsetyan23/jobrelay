import { describe, expect, it } from "vitest";
import { computeFingerprint } from "../../src/jobs/fingerprint.js";

describe("computeFingerprint", () => {
  it("is stable regardless of key order", () => {
    const a = computeFingerprint({ csv: "a,b\n1,2", column: "a" });
    const b = computeFingerprint({ column: "a", csv: "a,b\n1,2" });
    expect(a).toBe(b);
  });

  it("differs when a value differs", () => {
    const a = computeFingerprint({ csv: "a,b\n1,2", column: "a" });
    const b = computeFingerprint({ csv: "a,b\n1,3", column: "a" });
    expect(a).not.toBe(b);
  });

  it("is stable for nested structures regardless of key order", () => {
    const a = computeFingerprint({ outer: { x: 1, y: 2 }, list: [1, 2, 3] });
    const b = computeFingerprint({ list: [1, 2, 3], outer: { y: 2, x: 1 } });
    expect(a).toBe(b);
  });

  it("produces a 64-char hex sha256 digest", () => {
    const digest = computeFingerprint({ a: 1 });
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  });
});
