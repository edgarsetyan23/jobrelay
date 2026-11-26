import { describe, expect, it } from "vitest";
import { sanitizeFilenameForDisplay } from "../../src/util/sanitizeFilename.js";

describe("sanitizeFilenameForDisplay", () => {
  it.each(["\n", "\r", "\t", "\v", "\f", "\u2028", "\u2029"])(
    "removes control and line-breaking whitespace %j",
    (whitespace) => {
      expect(sanitizeFilenameForDisplay(`photo${whitespace}name.jpg`)).toBe("photoname.jpg");
    },
  );

  it.each(["/uploads/my photo-1.jpg", "C:\\uploads\\my photo-1.jpg", "C:\\uploads/nested\\my photo-1.jpg"])(
    "preserves ordinary spaces and punctuation in the basename of %s",
    (filename) => {
      expect(sanitizeFilenameForDisplay(filename)).toBe("my photo-1.jpg");
    },
  );

  it.each([undefined, "", "\n\t", "<>?!", "/uploads/", "C:\\uploads\\"])("uses a fallback for %j", (filename) => {
    expect(sanitizeFilenameForDisplay(filename)).toBe("upload");
  });

  it("limits the display label to 120 characters", () => {
    expect(sanitizeFilenameForDisplay("a".repeat(121))).toBe("a".repeat(120));
  });

  it.each(["caf\u00e9.jpg", "cafe\u0301.jpg", "\u5199\u771f.jpg"])(
    "preserves Unicode letters and accents in %s",
    (filename) => {
      expect(sanitizeFilenameForDisplay(filename)).toBe(filename);
    },
  );

  it("avoids splitting a supplementary Unicode letter at the length limit", () => {
    const letter = "\u{10400}";
    expect(sanitizeFilenameForDisplay(`${"a".repeat(118)}${letter}.jpg`)).toBe(`${"a".repeat(118)}${letter}`);
    expect(sanitizeFilenameForDisplay(`${"a".repeat(119)}${letter}.jpg`)).toBe("a".repeat(119));
  });

  it("removes trailing spaces exposed by truncation", () => {
    expect(sanitizeFilenameForDisplay(`${"a".repeat(119)} b.jpg`)).toBe("a".repeat(119));
  });
});
