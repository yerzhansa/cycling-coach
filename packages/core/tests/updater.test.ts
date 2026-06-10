import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSelfUpdateCommand, checkForUpdate, isUpdateAvailable } from "../src/updater.js";

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

describe("buildSelfUpdateCommand", () => {
  it("pins the exact version, disables lifecycle scripts, and pins the registry", () => {
    const cmd = buildSelfUpdateCommand("cycling-coach", "2026.5.3");
    expect(cmd).toContain("cycling-coach@2026.5.3");
    expect(cmd).toContain("--ignore-scripts");
    expect(cmd).toContain("--registry=https://registry.npmjs.org");
    expect(cmd).not.toContain("@latest");
  });

  it("falls back to the latest dist-tag when no version is given", () => {
    const cmd = buildSelfUpdateCommand("cycling-coach");
    expect(cmd).toContain("cycling-coach@latest");
    expect(cmd).toContain("--ignore-scripts");
    expect(cmd).toContain("--registry=https://registry.npmjs.org");
  });

  it("accepts a CalVer same-day re-release suffix", () => {
    expect(buildSelfUpdateCommand("cycling-coach", "2026.5.3-1")).toContain(
      "cycling-coach@2026.5.3-1",
    );
  });

  it("falls back to latest when the version contains shell metacharacters", () => {
    const cmd = buildSelfUpdateCommand("cycling-coach", "1.0.0; touch /tmp/pwned");
    expect(cmd).toContain("cycling-coach@latest");
    expect(cmd).not.toContain(";");
  });
});

describe("checkForUpdate", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The CYCLING_COACH_NO_UPDATE_CHECK opt-out gates only the automatic
  // startup notification (run-binary call site); operator-initiated
  // /update and /whatsnew must always be able to query the registry.
  it("queries the registry even when CYCLING_COACH_NO_UPDATE_CHECK is set", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: "2026.5.3" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("CYCLING_COACH_NO_UPDATE_CHECK", "1");
    try {
      const info = await checkForUpdate("cycling-coach");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(info?.latest).toBe("2026.5.3");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
