import { describe, expect, it } from "vitest";
import { isUpdateAvailable } from "../src/updater.js";

// Regression: the original `data.version !== current` returned true for ANY
// inequality, including the case where the running bot is ahead of npm — a
// Railway deploy from `main` hits this every restart while the publish
// pipeline lags behind. Users got "Update available: 2026.5.3 → 2026.5.1"
// which is a downgrade dressed as an upgrade.
describe("isUpdateAvailable", () => {
  it("returns true when latest > current (real upgrade)", () => {
    expect(isUpdateAvailable("2026.5.3", "2026.5.1")).toBe(true);
  });

  it("returns false when latest < current (the Railway-ahead-of-npm case)", () => {
    expect(isUpdateAvailable("2026.5.1", "2026.5.3")).toBe(false);
  });

  it("returns false when latest === current", () => {
    expect(isUpdateAvailable("2026.5.3", "2026.5.3")).toBe(false);
  });

  it('returns false when current is "unknown" (no throw)', () => {
    expect(isUpdateAvailable("2026.5.3", "unknown")).toBe(false);
  });

  it("returns false when latest is malformed (no throw)", () => {
    expect(isUpdateAvailable("not-a-version", "2026.5.3")).toBe(false);
  });

  it("respects semver patch ordering (10 > 9, not lex)", () => {
    expect(isUpdateAvailable("2026.5.10", "2026.5.9")).toBe(true);
    expect(isUpdateAvailable("2026.5.9", "2026.5.10")).toBe(false);
  });

  it("CalVer same-day re-release suffix is treated as NEWER", () => {
    // The project's CalVer scheme: 2026.5.3 → 2026.5.3-1 → 2026.5.3-2 ships
    // suffix bumps as same-day re-releases that come AFTER the original.
    // (This inverts standard semver, where -1 is a pre-release.)
    expect(isUpdateAvailable("2026.5.3-1", "2026.5.3")).toBe(true);
    expect(isUpdateAvailable("2026.5.3-2", "2026.5.3-1")).toBe(true);
    expect(isUpdateAvailable("2026.5.3", "2026.5.3-1")).toBe(false);
  });
});
