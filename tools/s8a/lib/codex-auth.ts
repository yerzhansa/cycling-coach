import { homedir } from "node:os";
import { join } from "node:path";

import {
  compareAndSaveStoredProfile,
  loadStoredProfileSnapshot,
  recoverAndSaveStoredProfile,
  refreshCodexToken,
  type CodexCredentials,
  type StoredProfile,
  type StoredProfileSnapshot,
} from "@enduragent/core";

export const AUTH_PROFILES_BASENAME = "auth-profiles.json";
export const AUTH_PROFILES_SOURCE_ENV = "S8A_AUTH_PROFILES";
export const CODEX_PROFILE_NAME = "openai-codex";
export const RECORD_TOKEN_MARGIN_MS = 10 * 60 * 1000;

function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function resolveAuthProfilesSource(
  env: Record<string, string | undefined> = process.env,
): string {
  const explicit = env[AUTH_PROFILES_SOURCE_ENV];
  if (explicit !== undefined && explicit !== "") return expandTilde(explicit);
  const override = env.ENDURAGENT_HOME;
  const root =
    override !== undefined && override !== ""
      ? expandTilde(override)
      : join(homedir(), ".enduragent");
  return join(root, "config", AUTH_PROFILES_BASENAME);
}

export function isUsableOAuthProfile(profile: StoredProfile | undefined): boolean {
  return (
    profile !== undefined &&
    profile.type === "oauth" &&
    typeof profile.access === "string" &&
    profile.access !== "" &&
    typeof profile.refresh === "string" &&
    profile.refresh !== ""
  );
}

export type ProfileInspection =
  | { readonly ok: true; readonly snapshot: StoredProfileSnapshot }
  | { readonly ok: false; readonly reason: string };

export function inspectCodexProfile(sourcePath: string, profileName: string): ProfileInspection {
  let snapshot: StoredProfileSnapshot | null;
  try {
    snapshot = loadStoredProfileSnapshot(sourcePath, profileName);
  } catch (err) {
    return {
      ok: false,
      reason: `${sourcePath} is unreadable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (snapshot === null) {
    return { ok: false, reason: `${sourcePath} carries no "${profileName}" profile` };
  }
  if (!isUsableOAuthProfile(snapshot.profile)) {
    return {
      ok: false,
      reason: `the "${profileName}" profile in ${sourcePath} is not a usable OAuth credential`,
    };
  }
  return { ok: true, snapshot };
}

export function stagedProfilesPath(tempHome: string): string {
  return join(tempHome, AUTH_PROFILES_BASENAME);
}

export function stageCodexProfile(params: {
  sourcePath: string;
  tempHome: string;
  profileName: string;
}): StoredProfileSnapshot {
  const inspected = inspectCodexProfile(params.sourcePath, params.profileName);
  if (!inspected.ok) throw new Error(inspected.reason);
  recoverAndSaveStoredProfile(
    stagedProfilesPath(params.tempHome),
    params.profileName,
    inspected.snapshot.profile,
  );
  return inspected.snapshot;
}

export function isProfileFreshEnough(
  profile: StoredProfile,
  nowMs: number,
  marginMs: number = RECORD_TOKEN_MARGIN_MS,
): boolean {
  const expires = profile.expires;
  if (typeof expires !== "number" || !Number.isFinite(expires)) return false;
  return nowMs <= expires - marginMs;
}

export type FreshenState = "already-fresh" | "refreshed" | "superseded";

export type FreshenOutcome =
  | { readonly ok: true; readonly state: FreshenState }
  | { readonly ok: false; readonly reason: string };

export async function ensureFreshCodexProfile(params: {
  sourcePath: string;
  profileName: string;
  nowMs: number;
  marginMs?: number;
  refresh?: (refreshToken: string) => Promise<CodexCredentials>;
}): Promise<FreshenOutcome> {
  const inspected = inspectCodexProfile(params.sourcePath, params.profileName);
  if (!inspected.ok) return { ok: false, reason: inspected.reason };
  const current = inspected.snapshot.profile;
  if (isProfileFreshEnough(current, params.nowMs, params.marginMs)) {
    return { ok: true, state: "already-fresh" };
  }
  const refresh = params.refresh ?? refreshCodexToken;
  let rotated: CodexCredentials;
  try {
    rotated = await refresh(current.refresh as string);
  } catch (err) {
    return {
      ok: false,
      reason: `refreshing the "${params.profileName}" access token failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  const next: StoredProfile = {
    ...current,
    type: "oauth",
    access: rotated.access,
    refresh: rotated.refresh,
    expires: rotated.expires,
    accountId: typeof rotated.accountId === "string" ? rotated.accountId : current.accountId,
  };
  const saved = await compareAndSaveStoredProfile(
    params.sourcePath,
    params.profileName,
    inspected.snapshot,
    next,
  );
  if (saved.status === "saved") return { ok: true, state: "refreshed" };
  if (saved.status === "missing") {
    return {
      ok: false,
      reason: `the "${params.profileName}" profile disappeared from ${params.sourcePath} mid-refresh`,
    };
  }
  if (
    isUsableOAuthProfile(saved.profile) &&
    isProfileFreshEnough(saved.profile, params.nowMs, params.marginMs)
  ) {
    return { ok: true, state: "superseded" };
  }
  return {
    ok: false,
    reason: `another writer replaced the "${params.profileName}" profile in ${params.sourcePath} while s8a was refreshing it, and the replacement is not usable for recording`,
  };
}

export type WriteBackOutcome = "unchanged" | "saved" | "superseded" | "missing" | "absent";

export async function persistRotatedCodexProfile(params: {
  sourcePath: string;
  tempHome: string;
  profileName: string;
  staged: StoredProfileSnapshot;
}): Promise<WriteBackOutcome> {
  const after = loadStoredProfileSnapshot(
    stagedProfilesPath(params.tempHome),
    params.profileName,
  );
  if (after === null) return "absent";
  if (after.revision === params.staged.revision) return "unchanged";
  const result = await compareAndSaveStoredProfile(
    params.sourcePath,
    params.profileName,
    params.staged,
    after.profile,
  );
  return result.status;
}
