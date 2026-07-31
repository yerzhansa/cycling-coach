import { describe, expect, it, vi } from "vitest";
import { isDesktopUpdateReleaseEligible } from "../src/main/update-eligibility.js";

const appPath = "/Applications/Enduragent.app/Contents/Resources/app.asar";

function eligibility(
  overrides: Partial<Parameters<typeof isDesktopUpdateReleaseEligible>[0]> = {},
): boolean {
  return isDesktopUpdateReleaseEligible({
    isPackaged: true,
    platform: "darwin",
    securitySmokeMode: false,
    appPath,
    currentVersion: "2026.7.23",
    readPackageJson: () => JSON.stringify({ version: "2026.7.23", enduragentDesktopRelease: true }),
    ...overrides,
  });
}

describe("desktop update release eligibility", () => {
  it("accepts only the marked packaged mac release with its exact stable version", () => {
    const readPackageJson = vi.fn(() => '{"version":"2026.7.23","enduragentDesktopRelease":true}');
    expect(eligibility({ readPackageJson })).toBe(true);
    expect(readPackageJson).toHaveBeenCalledWith(`${appPath}/package.json`);
  });

  it.each([
    { isPackaged: false, platform: "darwin" as const, securitySmokeMode: false },
    { isPackaged: true, platform: "linux" as const, securitySmokeMode: false },
    { isPackaged: true, platform: "darwin" as const, securitySmokeMode: true },
  ])("does not inspect metadata in an ineligible runtime: %o", (runtime) => {
    const readPackageJson = vi.fn(() => {
      throw new Error("must not read");
    });
    expect(eligibility({ ...runtime, readPackageJson })).toBe(false);
    expect(readPackageJson).not.toHaveBeenCalled();
  });

  it.each([
    ["ordinary package", JSON.stringify({ version: "0.0.1" }), "0.0.1"],
    ["unmarked stable package", JSON.stringify({ version: "2026.7.23" }), "2026.7.23"],
    [
      "ordinary package with false marker",
      JSON.stringify({ version: "2026.7.23", enduragentDesktopRelease: false }),
      "2026.7.23",
    ],
    [
      "nested marker",
      JSON.stringify({
        version: "2026.7.23",
        build: { enduragentDesktopRelease: true },
      }),
      "2026.7.23",
    ],
    [
      "mismatched version",
      JSON.stringify({ version: "2026.7.24", enduragentDesktopRelease: true }),
      "2026.7.23",
    ],
    [
      "impossible month",
      JSON.stringify({ version: "2026.13.1", enduragentDesktopRelease: true }),
      "2026.13.1",
    ],
    [
      "unsafe patch",
      JSON.stringify({
        version: "2026.7.9007199254740992",
        enduragentDesktopRelease: true,
      }),
      "2026.7.9007199254740992",
    ],
    [
      "invalid year",
      JSON.stringify({ version: "26.7.23", enduragentDesktopRelease: true }),
      "26.7.23",
    ],
  ])("rejects %s", (_case, raw, currentVersion) => {
    expect(eligibility({ currentVersion, readPackageJson: () => raw })).toBe(false);
  });

  it("fails closed when metadata is unreadable", () => {
    expect(
      eligibility({
        readPackageJson: () => {
          throw new Error("synthetic read failure");
        },
      }),
    ).toBe(false);
  });

  it.each([
    ["malformed", "not-json"],
    ["non-object", "null"],
    ["oversized", " ".repeat(64 * 1024 + 1)],
  ])("fails closed for %s metadata", (_case, raw) => {
    expect(eligibility({ readPackageJson: () => raw })).toBe(false);
  });
});
