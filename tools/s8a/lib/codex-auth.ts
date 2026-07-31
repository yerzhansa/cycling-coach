import { homedir } from "node:os";
import { join } from "node:path";

import {
  compareAndSaveStoredProfile,
  loadStoredProfileSnapshot,
  recoverAndSaveStoredProfile,
  type StoredProfile,
  type StoredProfileSnapshot,
} from "@enduragent/core";

export const AUTH_PROFILES_BASENAME = "auth-profiles.json";
export const AUTH_PROFILES_SOURCE_ENV = "S8A_AUTH_PROFILES";
export const CODEX_PROFILE_NAME = "openai-codex";

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
