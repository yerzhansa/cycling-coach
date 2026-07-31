import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  AUTH_PROFILES_BASENAME,
  AUTH_PROFILES_SOURCE_ENV,
  CODEX_PROFILE_NAME,
  ensureFreshCodexProfile,
  inspectCodexProfile,
  isProfileFreshEnough,
  isUsableOAuthProfile,
  persistRotatedCodexProfile,
  resolveAuthProfilesSource,
  stageCodexProfile,
  stagedProfilesPath,
} from "./codex-auth.js";

let root: string;
afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

function fixture(profiles: Record<string, unknown>): { sourcePath: string; tempHome: string } {
  root = mkdtempSync(join(tmpdir(), "s8a-codex-auth-"));
  const sourceDir = join(root, "config");
  const tempHome = join(root, "home");
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(tempHome, { recursive: true });
  const sourcePath = join(sourceDir, AUTH_PROFILES_BASENAME);
  writeFileSync(sourcePath, JSON.stringify(profiles), "utf-8");
  return { sourcePath, tempHome };
}

type StoredLike = Record<string, unknown>;

const usable = {
  type: "oauth",
  access: "access-token",
  refresh: "refresh-token",
  expires: 4_000_000_000_000,
  accountId: "acct-1",
};

describe("auth profiles source resolution", () => {
  it("prefers the explicit override and expands ~", () => {
    expect(resolveAuthProfilesSource({ [AUTH_PROFILES_SOURCE_ENV]: "/abs/profiles.json" })).toBe(
      "/abs/profiles.json",
    );
    expect(resolveAuthProfilesSource({ [AUTH_PROFILES_SOURCE_ENV]: "~/p.json" })).toBe(
      join(homedir(), "p.json"),
    );
  });

  it("falls back to the athlete home's config dir, honoring ENDURAGENT_HOME", () => {
    expect(resolveAuthProfilesSource({})).toBe(
      join(homedir(), ".enduragent", "config", AUTH_PROFILES_BASENAME),
    );
    expect(resolveAuthProfilesSource({ ENDURAGENT_HOME: "/custom/home" })).toBe(
      join("/custom/home", "config", AUTH_PROFILES_BASENAME),
    );
    expect(resolveAuthProfilesSource({ [AUTH_PROFILES_SOURCE_ENV]: "" })).toBe(
      join(homedir(), ".enduragent", "config", AUTH_PROFILES_BASENAME),
    );
  });
});

describe("profile inspection", () => {
  it("accepts a complete oauth credential and rejects the incomplete shapes", () => {
    expect(isUsableOAuthProfile(usable)).toBe(true);
    expect(isUsableOAuthProfile(undefined)).toBe(false);
    expect(isUsableOAuthProfile({ ...usable, type: "api" })).toBe(false);
    expect(isUsableOAuthProfile({ ...usable, refresh: "" })).toBe(false);
    expect(isUsableOAuthProfile({ ...usable, access: 7 })).toBe(false);
  });

  it("reports a missing file, a missing profile, and an unusable profile distinctly", () => {
    const { sourcePath } = fixture({ other: usable });
    const missingFile = inspectCodexProfile(join(root, "nope.json"), CODEX_PROFILE_NAME);
    expect(missingFile.ok).toBe(false);
    const missingProfile = inspectCodexProfile(sourcePath, CODEX_PROFILE_NAME);
    expect(missingProfile.ok).toBe(false);
    if (!missingProfile.ok) expect(missingProfile.reason).toContain("carries no");
    writeFileSync(sourcePath, JSON.stringify({ [CODEX_PROFILE_NAME]: { type: "api" } }), "utf-8");
    const unusable = inspectCodexProfile(sourcePath, CODEX_PROFILE_NAME);
    expect(unusable.ok).toBe(false);
    if (!unusable.ok) expect(unusable.reason).toContain("not a usable OAuth credential");
  });

  it("accepts a usable profile and exposes its snapshot", () => {
    const { sourcePath } = fixture({ [CODEX_PROFILE_NAME]: usable });
    const inspected = inspectCodexProfile(sourcePath, CODEX_PROFILE_NAME);
    expect(inspected.ok).toBe(true);
    if (inspected.ok) expect(inspected.snapshot.profile.refresh).toBe("refresh-token");
  });
});

describe("pre-spawn token freshness", () => {
  const NOW = 3_000_000_000_000;
  const expired = { ...usable, expires: NOW - 60_000 };
  const rotated = {
    access: "access-2",
    refresh: "refresh-2",
    expires: NOW + 3_600_000,
    accountId: "acct-2",
  };

  it("reads a still-valid token as fresh and never calls the refresh endpoint", async () => {
    const { sourcePath } = fixture({ [CODEX_PROFILE_NAME]: usable });
    const before = readFileSync(sourcePath, "utf-8");
    const outcome = await ensureFreshCodexProfile({
      sourcePath,
      profileName: CODEX_PROFILE_NAME,
      nowMs: NOW,
      refresh: () => Promise.reject(new Error("must not refresh")),
    });
    expect(outcome).toEqual({ ok: true, state: "already-fresh" });
    expect(readFileSync(sourcePath, "utf-8")).toBe(before);
  });

  it("treats a token inside the margin, and one with no numeric expiry, as stale", () => {
    expect(isProfileFreshEnough(usable, NOW)).toBe(true);
    expect(isProfileFreshEnough({ ...usable, expires: NOW + 60_000 }, NOW)).toBe(false);
    expect(isProfileFreshEnough({ ...usable, expires: null }, NOW)).toBe(false);
    expect(isProfileFreshEnough({ ...usable, expires: "soon" }, NOW)).toBe(false);
  });

  it("refreshes an expired token and persists the rotated credential to the source", async () => {
    const { sourcePath } = fixture({ [CODEX_PROFILE_NAME]: expired, other: usable });
    const outcome = await ensureFreshCodexProfile({
      sourcePath,
      profileName: CODEX_PROFILE_NAME,
      nowMs: NOW,
      refresh: (token) => {
        expect(token).toBe("refresh-token");
        return Promise.resolve(rotated);
      },
    });
    expect(outcome).toEqual({ ok: true, state: "refreshed" });
    const source = JSON.parse(readFileSync(sourcePath, "utf-8")) as Record<string, StoredLike>;
    expect(source[CODEX_PROFILE_NAME]).toEqual({ ...expired, ...rotated });
    expect(source.other).toEqual(usable);
  });

  it("reports the refresh failure instead of spawning a doomed record child", async () => {
    const { sourcePath } = fixture({ [CODEX_PROFILE_NAME]: expired });
    const outcome = await ensureFreshCodexProfile({
      sourcePath,
      profileName: CODEX_PROFILE_NAME,
      nowMs: NOW,
      refresh: () => Promise.reject(new Error("reauth required")),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("reauth required");
  });

  it("accepts a fresher credential another writer landed mid-refresh", async () => {
    const { sourcePath } = fixture({ [CODEX_PROFILE_NAME]: expired });
    const outcome = await ensureFreshCodexProfile({
      sourcePath,
      profileName: CODEX_PROFILE_NAME,
      nowMs: NOW,
      refresh: () => {
        writeFileSync(
          sourcePath,
          JSON.stringify({ [CODEX_PROFILE_NAME]: { ...usable, access: "from-the-desktop" } }),
          "utf-8",
        );
        return Promise.resolve(rotated);
      },
    });
    expect(outcome).toEqual({ ok: true, state: "superseded" });
    const source = JSON.parse(readFileSync(sourcePath, "utf-8")) as Record<string, StoredLike>;
    expect(source[CODEX_PROFILE_NAME]).toEqual({ ...usable, access: "from-the-desktop" });
  });

  it("fails when the concurrent replacement is itself unusable", async () => {
    const { sourcePath } = fixture({ [CODEX_PROFILE_NAME]: expired });
    const outcome = await ensureFreshCodexProfile({
      sourcePath,
      profileName: CODEX_PROFILE_NAME,
      nowMs: NOW,
      refresh: () => {
        writeFileSync(
          sourcePath,
          JSON.stringify({ [CODEX_PROFILE_NAME]: { type: "api", key: "k" } }),
          "utf-8",
        );
        return Promise.resolve(rotated);
      },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("not usable for recording");
  });

  it("fails when the profile is absent from the source", async () => {
    const { sourcePath } = fixture({ other: usable });
    const outcome = await ensureFreshCodexProfile({
      sourcePath,
      profileName: CODEX_PROFILE_NAME,
      nowMs: NOW,
      refresh: () => Promise.reject(new Error("must not refresh")),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("carries no");
  });
});

describe("staging and rotation write-back", () => {
  it("copies only the named profile into the temp home", () => {
    const { sourcePath, tempHome } = fixture({ [CODEX_PROFILE_NAME]: usable, other: usable });
    stageCodexProfile({ sourcePath, tempHome, profileName: CODEX_PROFILE_NAME });
    const staged = JSON.parse(readFileSync(stagedProfilesPath(tempHome), "utf-8")) as Record<
      string,
      unknown
    >;
    expect(Object.keys(staged)).toEqual([CODEX_PROFILE_NAME]);
    expect(staged[CODEX_PROFILE_NAME]).toEqual(usable);
  });

  it("throws with the inspection reason when the source has no usable profile", () => {
    const { sourcePath, tempHome } = fixture({});
    expect(() =>
      stageCodexProfile({ sourcePath, tempHome, profileName: CODEX_PROFILE_NAME }),
    ).toThrow(/carries no/);
  });

  it("leaves the source untouched when the run did not rotate the token", async () => {
    const { sourcePath, tempHome } = fixture({ [CODEX_PROFILE_NAME]: usable });
    const snapshot = stageCodexProfile({ sourcePath, tempHome, profileName: CODEX_PROFILE_NAME });
    const before = readFileSync(sourcePath, "utf-8");
    const outcome = await persistRotatedCodexProfile({
      sourcePath,
      tempHome,
      profileName: CODEX_PROFILE_NAME,
      staged: snapshot,
    });
    expect(outcome).toBe("unchanged");
    expect(readFileSync(sourcePath, "utf-8")).toBe(before);
  });

  it("writes a rotated refresh token back into the source, preserving sibling profiles", async () => {
    const { sourcePath, tempHome } = fixture({ [CODEX_PROFILE_NAME]: usable, other: usable });
    const snapshot = stageCodexProfile({ sourcePath, tempHome, profileName: CODEX_PROFILE_NAME });
    const rotated = { ...usable, access: "access-2", refresh: "refresh-2" };
    writeFileSync(
      stagedProfilesPath(tempHome),
      JSON.stringify({ [CODEX_PROFILE_NAME]: rotated }),
      "utf-8",
    );
    const outcome = await persistRotatedCodexProfile({
      sourcePath,
      tempHome,
      profileName: CODEX_PROFILE_NAME,
      staged: snapshot,
    });
    expect(outcome).toBe("saved");
    const source = JSON.parse(readFileSync(sourcePath, "utf-8")) as Record<string, unknown>;
    expect(source[CODEX_PROFILE_NAME]).toEqual(rotated);
    expect(source.other).toEqual(usable);
  });

  it("refuses to clobber a source another writer rotated first", async () => {
    const { sourcePath, tempHome } = fixture({ [CODEX_PROFILE_NAME]: usable });
    const snapshot = stageCodexProfile({ sourcePath, tempHome, profileName: CODEX_PROFILE_NAME });
    const concurrent = { ...usable, refresh: "refresh-from-the-desktop" };
    writeFileSync(sourcePath, JSON.stringify({ [CODEX_PROFILE_NAME]: concurrent }), "utf-8");
    writeFileSync(
      stagedProfilesPath(tempHome),
      JSON.stringify({ [CODEX_PROFILE_NAME]: { ...usable, refresh: "refresh-from-s8a" } }),
      "utf-8",
    );
    const outcome = await persistRotatedCodexProfile({
      sourcePath,
      tempHome,
      profileName: CODEX_PROFILE_NAME,
      staged: snapshot,
    });
    expect(outcome).toBe("superseded");
    const source = JSON.parse(readFileSync(sourcePath, "utf-8")) as Record<string, unknown>;
    expect(source[CODEX_PROFILE_NAME]).toEqual(concurrent);
  });

  it("reports an absent staged file rather than writing anything", async () => {
    const { sourcePath, tempHome } = fixture({ [CODEX_PROFILE_NAME]: usable });
    const snapshot = stageCodexProfile({ sourcePath, tempHome, profileName: CODEX_PROFILE_NAME });
    rmSync(stagedProfilesPath(tempHome));
    await expect(
      persistRotatedCodexProfile({
        sourcePath,
        tempHome,
        profileName: CODEX_PROFILE_NAME,
        staged: snapshot,
      }),
    ).resolves.toBe("absent");
  });
});
