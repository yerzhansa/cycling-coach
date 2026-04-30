import { describe, it, expect } from "vitest";
import type { MemorySnapshot } from "@enduragent/core";
import { cyclingSport, CYCLING_VOCABULARY } from "../src/cycling/sport.js";

function snapshot(sections: Record<string, string | null>): MemorySnapshot {
  return {
    read: (name: string) => sections[name] ?? null,
    has: (name: string) => sections[name] != null && sections[name] !== "",
    listSections: () => Object.keys(sections),
  };
}

function resolve(sections: Record<string, string | null>): readonly string[] {
  const fn = cyclingSport.mustPreserveTokens;
  if (typeof fn !== "function") throw new Error("expected function form");
  return fn(snapshot(sections));
}

describe("cyclingSport.mustPreserveTokens", () => {
  it("returns CYCLING_VOCABULARY only when cycling-profile is absent", () => {
    expect(resolve({})).toEqual(CYCLING_VOCABULARY);
  });

  it('adds "FTP 247W" when profile contains "FTP 247W"', () => {
    expect(resolve({ "cycling-profile": "FTP 247W, 72kg" })).toContain("FTP 247W");
  });

  it('normalizes unit-less "FTP 247" to "FTP 247W"', () => {
    expect(resolve({ "cycling-profile": "FTP 247, 72kg" })).toContain("FTP 247W");
  });

  it('handles "FTP: 247W" (colon separator)', () => {
    expect(resolve({ "cycling-profile": "FTP: 247W" })).toContain("FTP 247W");
  });

  it('handles "FTP - 247" (dash separator)', () => {
    expect(resolve({ "cycling-profile": "FTP - 247" })).toContain("FTP 247W");
  });

  it("returns first match only when multiple FTPs are present", () => {
    const tokens = resolve({
      "cycling-profile": "FTP 247W (current). Earlier FTP 235W in March.",
    });
    expect(tokens).toContain("FTP 247W");
    expect(tokens).not.toContain("FTP 235W");
  });

  it("returns vocabulary only for new athletes (cycling-profile present, no FTP)", () => {
    expect(resolve({ "cycling-profile": "Beginner; weight tracking only." })).toEqual(
      CYCLING_VOCABULARY,
    );
  });

  it("rejects unrealistically low FTP (< 50W) via 2-digit minimum", () => {
    const tokens = resolve({ "cycling-profile": "FTP 5W (placeholder)" });
    expect(tokens.some((t) => t.startsWith("FTP "))).toBe(false);
  });

  it("rejects 4-digit year collisions: 'FTP test 2024-06: 240W' → captures 247, not 2024", () => {
    // The first "FTP" is followed by " test" — separator class doesn't match
    // letters, so capture fails there. Regex moves to "current FTP 247W" and
    // captures 247. Pinned to assert the deterministic outcome.
    const tokens = resolve({
      "cycling-profile": "FTP test 2024-06: 240W resulted in current FTP 247W",
    });
    expect(tokens).toContain("FTP 247W");
    expect(tokens).not.toContain("FTP 2024W");
    expect(tokens).not.toContain("FTP 240W");
  });

  it("rejects 4-digit FTP values (intentional guard against year capture)", () => {
    const tokens = resolve({ "cycling-profile": "FTP 1000W" });
    expect(tokens.some((t) => t.startsWith("FTP "))).toBe(false);
  });

  it("rejects trailing junk: 'FTP 247abc' → no capture (word boundary)", () => {
    const tokens = resolve({ "cycling-profile": "FTP 247abc" });
    expect(tokens.some((t) => t.startsWith("FTP "))).toBe(false);
  });

  it("captures FTP at start of section", () => {
    expect(resolve({ "cycling-profile": "FTP 280W. Max HR 188." })).toContain("FTP 280W");
  });

  it("captures FTP after newline / mid-section", () => {
    expect(
      resolve({
        "cycling-profile": "Max HR 188.\nFTP 280W.\nResting HR 52.",
      }),
    ).toContain("FTP 280W");
  });

  it("captures FTP at end of line (no trailing punctuation)", () => {
    expect(
      resolve({ "cycling-profile": "Max HR 188\nFTP 280W\nResting HR 52" }),
    ).toContain("FTP 280W");
  });
});
