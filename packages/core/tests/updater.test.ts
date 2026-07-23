import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCheckUrl,
  buildSelfUpdateCommand,
  checkForUpdate,
  getCurrentVersion,
  getInstanceId,
  isManagedDeploy,
  isStableCalVer,
  isUpdateAvailable,
} from "../src/updater.js";

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

  it("orders stable successors within the same month", () => {
    expect(isUpdateAvailable("2026.7.3", "2026.7.2")).toBe(true);
    expect(isUpdateAvailable("2026.7.2", "2026.7.3")).toBe(false);
  });

  it("orders installed historical suffix releases for compatibility", () => {
    expect(isUpdateAvailable("2026.5.3-1", "2026.5.3-0")).toBe(true);
    expect(isUpdateAvailable("2026.5.3-1", "2026.5.3")).toBe(true);
    expect(isUpdateAvailable("2026.5.3-2", "2026.5.3-1")).toBe(true);
    expect(isUpdateAvailable("2026.5.3", "2026.5.3-1")).toBe(false);
  });

  it("recognizes the stable successor to an installed historical suffix release", () => {
    expect(isUpdateAvailable("2026.6.26", "2026.6.25-1")).toBe(true);
    expect(isUpdateAvailable("2026.6.25-1", "2026.6.26")).toBe(false);
  });

  it.each([
    ["2026.0.1", "2026.1.1"],
    ["2026.13.1", "2026.12.1"],
    ["2026.7.9007199254740992", "2026.7.1"],
    ["999.7.1", "2026.7.1"],
    ["10000.7.1", "2026.7.1"],
    ["0000.7.1", "2026.7.1"],
  ])("rejects invalid or unsafe latest/current CalVer %s / %s", (latest, current) => {
    expect(isUpdateAvailable(latest, current)).toBe(false);
    expect(isUpdateAvailable(current, latest)).toBe(false);
  });
});

describe("isStableCalVer", () => {
  it.each(["2026.1.0", "2026.12.9007199254740991"])("accepts stable CalVer %s", (version) => {
    expect(isStableCalVer(version)).toBe(true);
  });

  it.each([
    "2026.0.1",
    "2026.13.1",
    "2026.7.9007199254740992",
    "999.7.1",
    "10000.7.1",
    "0000.7.1",
    "2026.07.1",
    "2026.7.01",
    "2026.7.1-1",
    `2026.7.${"1".repeat(33)}`,
  ])("rejects non-stable CalVer %s", (version) => {
    expect(isStableCalVer(version)).toBe(false);
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

  it("accepts an installed historical CalVer suffix", () => {
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

describe("isManagedDeploy", () => {
  it("treats 1 and true as managed deploy signals", () => {
    expect(isManagedDeploy("cycling-coach", { CYCLING_COACH_MANAGED_DEPLOY: "1" })).toBe(true);
    expect(isManagedDeploy("cycling-coach", { CYCLING_COACH_MANAGED_DEPLOY: "true" })).toBe(true);
    expect(isManagedDeploy("cycling-coach", { CYCLING_COACH_MANAGED_DEPLOY: " TRUE " })).toBe(true);
  });

  it("treats absent or non-true values as unmanaged installs", () => {
    expect(isManagedDeploy("cycling-coach", {})).toBe(false);
    expect(isManagedDeploy("cycling-coach", { CYCLING_COACH_MANAGED_DEPLOY: "0" })).toBe(false);
    expect(isManagedDeploy("cycling-coach", { CYCLING_COACH_MANAGED_DEPLOY: "false" })).toBe(false);
  });

  it("reads the per-binary env name, not a hardcoded prefix", () => {
    expect(isManagedDeploy("running-coach", { RUNNING_COACH_MANAGED_DEPLOY: "1" })).toBe(true);
    // A different binary's prefix must not leak across — the leakage is fixed, not aliased.
    expect(isManagedDeploy("running-coach", { CYCLING_COACH_MANAGED_DEPLOY: "1" })).toBe(false);
  });
});

describe("buildCheckUrl", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "cc-updater-url-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("builds the ping URL with exactly bin, version, channel, instance when a dataDir is given (production)", () => {
    vi.stubEnv("NODE_ENV", "production");
    const url = new URL(buildCheckUrl("cycling-coach", dataDir));
    expect(`${url.origin}${url.pathname}`).toBe("https://ping.enduragent.icu/v1/check");
    expect([...url.searchParams.keys()].sort()).toEqual(["bin", "channel", "instance", "version"]);
    expect(url.searchParams.get("bin")).toBe("cycling-coach");
    expect(url.searchParams.get("version")).toBe(getCurrentVersion("cycling-coach"));
    expect(url.searchParams.get("channel")).toBe("npm");
    expect(url.searchParams.get("instance")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("omits the instance param when no dataDir is given (production)", () => {
    vi.stubEnv("NODE_ENV", "production");
    const url = new URL(buildCheckUrl("cycling-coach"));
    expect(url.searchParams.has("instance")).toBe(false);
    expect([...url.searchParams.keys()].sort()).toEqual(["bin", "channel", "version"]);
  });

  it("channel is docker under CYCLING_COACH_MANAGED_DEPLOY=1 (production)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CYCLING_COACH_MANAGED_DEPLOY", "1");
    expect(new URL(buildCheckUrl("cycling-coach")).searchParams.get("channel")).toBe("docker");
  });

  it("returns the plain npm registry URL under NODE_ENV=development", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(buildCheckUrl("cycling-coach", dataDir)).toBe(
      "https://registry.npmjs.org/cycling-coach/latest",
    );
  });

  it("returns the plain npm registry URL under NODE_ENV=test", () => {
    vi.stubEnv("NODE_ENV", "test");
    expect(buildCheckUrl("cycling-coach", dataDir)).toBe(
      "https://registry.npmjs.org/cycling-coach/latest",
    );
  });
});

describe("getInstanceId", () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "cc-instance-id-"));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("returns the same UUID across calls, creating the dir if missing", () => {
    const dir = join(base, "not-yet-created");
    expect(existsSync(dir)).toBe(false);
    const first = getInstanceId(dir);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(existsSync(join(dir, "instance-id"))).toBe(true);
    expect(getInstanceId(dir)).toBe(first);
  });

  it("returns a fresh valid UUID without throwing when the dir is unwritable", () => {
    const filePath = join(base, "a-file");
    writeFileSync(filePath, "x");
    // A path whose parent is a regular file cannot be created → mkdirSync throws.
    const unwritable = join(filePath, "nested");
    let id = "";
    expect(() => {
      id = getInstanceId(unwritable);
    }).not.toThrow();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("checkForUpdate", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
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

  it("falls back to the npm registry when the ping endpoint fails (production)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: string) => {
      urls.push(input);
      if (urls.length === 1) throw new Error("ping endpoint down");
      return { ok: true, json: async () => ({ version: "2026.5.10" }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const info = await checkForUpdate("cycling-coach");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(urls[0]).toContain("ping.enduragent.icu");
    expect(urls[1]).toBe("https://registry.npmjs.org/cycling-coach/latest");
    expect(info?.latest).toBe("2026.5.10");
  });

  it("returns null (never throws) when both hosts fail (production)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchMock);
    const info = await checkForUpdate("cycling-coach");
    expect(info).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // vitest sets NODE_ENV=test globally, so no ping.enduragent.icu URL is
  // ever constructed and the primary (npm) failure does NOT retry the same host.
  it("never constructs a ping.enduragent.icu URL under NODE_ENV=test", async () => {
    expect(process.env.NODE_ENV).toBe("test");
    expect(buildCheckUrl("cycling-coach", "/tmp/does-not-matter")).not.toContain(
      "ping.enduragent.icu",
    );
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: string) => {
      urls.push(input);
      throw new Error("offline");
    });
    vi.stubGlobal("fetch", fetchMock);
    const info = await checkForUpdate("cycling-coach", "/tmp/does-not-matter");
    expect(info).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(urls.every((u) => !u.includes("ping.enduragent.icu"))).toBe(true);
  });
});
