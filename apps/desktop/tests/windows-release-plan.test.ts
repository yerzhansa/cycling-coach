import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import {
  WINDOWS_AUTHENTICODE_PENDING,
  assertKnownWindowsReleaseAssets,
  createWindowsReleasePlan,
  parseWindowsReleaseUpdaterMetadata,
  safeWindowsReleasePlanMessage,
  windowsReleaseArtifactNames,
  windowsReleaseAssetNames,
} from "../scripts/windows-release-plan.mjs";

const feedUrl = "https://github.com/yerzhansa/enduragent/releases/latest/download/";
const commit = "a".repeat(40);

function planInput(overrides: Record<string, unknown> = {}) {
  return {
    version: "0.1.5",
    commit,
    feedUrl,
    mode: "steady" as const,
    baselineVersion: "0.1.2",
    repositoryRoot: "/synthetic/repository",
    desktopRoot: "/synthetic/repository/apps/desktop",
    ...overrides,
  };
}

describe("Windows release plan", () => {
  it("freezes the exact Windows asset names", () => {
    const names = windowsReleaseArtifactNames("0.1.5");
    expect(names).toEqual({
      installer: "Enduragent-0.1.5-x64.exe",
      blockmap: "Enduragent-0.1.5-x64.exe.blockmap",
      metadata: "latest.yml",
    });
    expect(windowsReleaseAssetNames("0.1.5")).toEqual([
      "Enduragent-0.1.5-x64.exe",
      "Enduragent-0.1.5-x64.exe.blockmap",
      "latest.yml",
    ]);
    expect(Object.isFrozen(names)).toBe(true);
  });

  it("rejects duplicate, unknown, and missing Windows release assets", () => {
    const names = windowsReleaseAssetNames("0.1.5");
    expect(() => assertKnownWindowsReleaseAssets([...names, names[0]!], "0.1.5")).toThrow(
      `duplicate Windows release asset: ${names[0]}`,
    );
    expect(() => assertKnownWindowsReleaseAssets([...names, "old.zip"], "0.1.5")).toThrow(
      "unknown Windows release asset: old.zip",
    );
    expect(() => assertKnownWindowsReleaseAssets(names.slice(1), "0.1.5")).toThrow(
      `missing Windows release asset: ${names[0]}`,
    );
  });

  it("enforces genesis and steady baseline rules while allowing lag", () => {
    expect(() =>
      createWindowsReleasePlan(planInput({ mode: "genesis", baselineVersion: "0.1.2" })),
    ).toThrow("genesis Windows release must not name a baseline");
    expect(() => createWindowsReleasePlan(planInput({ baselineVersion: undefined }))).toThrow(
      "steady Windows release requires a lower stable baseline version",
    );
    expect(() => createWindowsReleasePlan(planInput({ baselineVersion: "0.1.5" }))).toThrow(
      "steady Windows release requires a lower stable baseline version",
    );
    expect(() => createWindowsReleasePlan(planInput({ baselineVersion: "0.1.6" }))).toThrow(
      "steady Windows release requires a lower stable baseline version",
    );
    expect(createWindowsReleasePlan(planInput()).baselineVersion).toBe("0.1.2");
  });

  it("parses exact updater identity with an optional publisher", () => {
    const base = {
      provider: "generic",
      url: feedUrl,
      channel: "latest",
      updaterCacheDirName: "@enduragentdesktop-updater",
    };
    expect(parseWindowsReleaseUpdaterMetadata(stringify(base))).toEqual(base);
    const publisherName = "CN=Enduragent Test";
    expect(
      parseWindowsReleaseUpdaterMetadata(stringify({ ...base, publisherName }), {
        expectedPublisherName: publisherName,
      }),
    ).toEqual({ ...base, publisherName });
    expect(() =>
      parseWindowsReleaseUpdaterMetadata(stringify({ ...base, publisherName }), {
        expectedPublisherName: "CN=Different Publisher",
      }),
    ).toThrow("release updater publisher name mismatch");
    expect(() =>
      parseWindowsReleaseUpdaterMetadata(stringify({ ...base, unexpected: true })),
    ).toThrow("release updater metadata is invalid");
  });

  it("creates the signed NSIS builder contract with differential packaging", () => {
    const plan = createWindowsReleasePlan(planInput());
    expect(plan).toMatchObject({
      version: "0.1.5",
      commit,
      tag: "enduragent-desktop@0.1.5",
      platform: "win32",
      arch: "x64",
      mode: "steady",
      authenticode: WINDOWS_AUTHENTICODE_PENDING,
    });
    expect(plan.builderOptions.config.forceCodeSigning).toBe(true);
    expect(plan.builderOptions.config.nsis.differentialPackage).toBe(true);
    expect(plan.builderOptions.config.publish).toEqual([
      { provider: "generic", url: feedUrl, channel: "latest" },
    ]);
    expect(plan.builderOptions.publish).toBe("never");
    expect(plan.builderOptions.config.win).toEqual({
      verifyUpdateCodeSignature: true,
      target: [{ target: "nsis", arch: ["x64"] }],
    });
    expect(Object.isFrozen(plan)).toBe(true);
  });

  it("exposes only safe planner failures", () => {
    expect(
      safeWindowsReleasePlanMessage(
        new TypeError("steady Windows release requires a lower stable baseline version"),
      ),
    ).toBe("steady Windows release requires a lower stable baseline version");
    expect(safeWindowsReleasePlanMessage(new Error("foreign"))).toBeUndefined();
  });
});
