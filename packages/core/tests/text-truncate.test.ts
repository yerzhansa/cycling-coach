import { describe, it, expect } from "vitest";
import { truncateUtf16Safe } from "../src/text-truncate.js";
import { chunkHtml } from "../src/channels/telegram.js";

// Local stand-in for String.prototype.isWellFormed (ES2024, above the repo's
// TS lib target): true when the string contains no lone surrogates.
function isWellFormedUtf16(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

describe("truncateUtf16Safe", () => {
  it("returns short strings unchanged", () => {
    expect(truncateUtf16Safe("abc", 10)).toBe("abc");
    expect(truncateUtf16Safe("", 10)).toBe("");
  });

  it("cuts at maxChars when the boundary is safe", () => {
    expect(truncateUtf16Safe("abcdef", 3)).toBe("abc");
  });

  it("backs off by one when the cut would split a surrogate pair", () => {
    // "ab" + 🚴 (2 UTF-16 units) — a cut at 3 lands between the halves.
    const s = "ab\u{1F6B4}cd";
    const out = truncateUtf16Safe(s, 3);
    expect(out).toBe("ab");
    expect(isWellFormedUtf16(out)).toBe(true);
  });

  it("keeps a full emoji when the cut lands after its low surrogate", () => {
    const s = "ab\u{1F6B4}cd";
    const out = truncateUtf16Safe(s, 4);
    expect(out).toBe("ab\u{1F6B4}");
    expect(isWellFormedUtf16(out)).toBe(true);
  });

  it("returns empty for non-positive maxChars", () => {
    expect(truncateUtf16Safe("abc", 0)).toBe("");
    expect(truncateUtf16Safe("abc", -1)).toBe("");
  });

  it("makes forward progress at maxChars 1 even on a leading high surrogate", () => {
    const s = "\u{1F6B4}x";
    expect(truncateUtf16Safe(s, 1).length).toBe(1);
  });

  it("emoji straddling arbitrary cut points always yields well-formed output", () => {
    const s = "🚴🏔️💪 ride done 🎉".repeat(3);
    for (let max = 1; max <= s.length; max++) {
      const out = truncateUtf16Safe(s, max);
      if (max > 1) expect(isWellFormedUtf16(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(max);
      expect(out.length).toBeGreaterThan(0);
    }
  });
});

describe("chunkHtml <pre> splitting with boundary emoji", () => {
  const MAX = 4096;

  it("never emits a pre chunk with a lone surrogate", () => {
    // One giant single row of emoji forces splitPreBlock's fixed-width
    // fallback; every fixed-width boundary lands mid-pair without the fix.
    const row = "\u{1F6B4}".repeat(Math.ceil((MAX + 500) / 2));
    const pre = `<pre>${row}</pre>`;
    const chunks = chunkHtml(pre, MAX);
    expect(chunks.length).toBeGreaterThan(1);
    let reassembled = "";
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(MAX);
      expect(isWellFormedUtf16(c)).toBe(true);
      reassembled += c.replace(/^<pre>/, "").replace(/<\/pre>$/, "");
    }
    expect(reassembled).toBe(row);
  });
});
