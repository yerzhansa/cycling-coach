import { describe, expect, it } from "vitest";
import { isDesktopUpdateAvailable, isStableDesktopVersion } from "../src/main/desktop-version.js";

describe("desktop versions", () => {
  it.each(["0.1.0", "0.1.1", "1.0.0", "12.34.56"])("accepts stable SemVer %s", (version) => {
    expect(isStableDesktopVersion(version)).toBe(true);
  });

  it.each(["v0.1.0", "0.01.0", "0.1", "0.1.0-beta.1", "0.1.9007199254740992", ""])(
    "rejects non-stable SemVer %s",
    (version) => {
      expect(isStableDesktopVersion(version)).toBe(false);
    },
  );

  it("compares major, minor, and patch numerically", () => {
    expect(isDesktopUpdateAvailable("0.1.1", "0.1.0")).toBe(true);
    expect(isDesktopUpdateAvailable("0.2.0", "0.1.99")).toBe(true);
    expect(isDesktopUpdateAvailable("1.0.0", "0.99.99")).toBe(true);
    expect(isDesktopUpdateAvailable("0.1.0", "0.1.0")).toBe(false);
    expect(isDesktopUpdateAvailable("0.1.0", "0.1.1")).toBe(false);
    expect(isDesktopUpdateAvailable("0.1.0-beta.1", "0.1.0")).toBe(false);
  });
});
