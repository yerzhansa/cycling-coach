import { join } from "node:path";
import { refreshCodexToken } from "../agent/codex/oauth.js";
import {
  compareAndSaveStoredProfile,
  loadStoredProfileSnapshot,
  recoverAndSaveStoredProfile,
  type StoredProfile,
  type StoredProfileSnapshot,
} from "./profile-store.js";
import { readRefreshFailureReason } from "./refresh-failure.js";
import { RefreshTokenReusedError } from "./refresh-token-reused-error.js";

export { RefreshTokenReusedError } from "./refresh-token-reused-error.js";

import { CONFIG_DIR } from "../config.js";

// ============================================================================
// TYPES
// ============================================================================

export interface OAuthCredential extends StoredProfile {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  email?: string;
}

// ============================================================================
// STORAGE
// ============================================================================

const PROFILES_FILE = join(CONFIG_DIR, "auth-profiles.json");
const REFRESH_THRESHOLD_MS = 5 * 60 * 1000;

interface OAuthProfileSnapshot {
  readonly profile: OAuthCredential;
  readonly stored: StoredProfileSnapshot;
}

function decodeOAuthCredential(profile: StoredProfile): OAuthCredential | null {
  if (
    profile.type !== "oauth" ||
    typeof profile.access !== "string" ||
    typeof profile.refresh !== "string" ||
    (typeof profile.expires !== "number" && profile.expires !== null) ||
    (profile.accountId !== undefined && typeof profile.accountId !== "string") ||
    (profile.email !== undefined && typeof profile.email !== "string")
  ) {
    return null;
  }
  return {
    ...profile,
    type: "oauth",
    access: profile.access,
    refresh: profile.refresh,
    expires: profile.expires === null ? Number.NaN : profile.expires,
    accountId: profile.accountId,
    email: profile.email,
  };
}

function loadOAuthProfileSnapshot(name: string): OAuthProfileSnapshot | null {
  const stored = loadStoredProfileSnapshot(PROFILES_FILE, name);
  if (stored === null) return null;
  const profile = decodeOAuthCredential(stored.profile);
  return profile === null ? null : { profile, stored };
}

function missingProfile(name: string): Error {
  return new Error(`No OAuth profile "${name}". Run \`cycling-coach setup\` to create one.`);
}

export function loadProfile(name: string): OAuthCredential | null {
  try {
    return loadOAuthProfileSnapshot(name)?.profile ?? null;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) return null;
    throw error;
  }
}

export function saveProfile(name: string, cred: OAuthCredential): void {
  recoverAndSaveStoredProfile(PROFILES_FILE, name, cred);
}

function isExpiredOrUnusable(cred: OAuthCredential): boolean {
  if (!Number.isFinite(cred.expires)) return true;
  return Date.now() > cred.expires - REFRESH_THRESHOLD_MS;
}

// ============================================================================
// REFRESH
// ============================================================================

const REFRESH_RETRY_DELAY_MS = 2_000;

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (signal === undefined) return new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function refreshWithReauthConfirmation(
  name: string,
  initial: OAuthProfileSnapshot,
  signal?: AbortSignal,
) {
  try {
    return {
      refreshed: await refreshCodexToken(initial.profile.refresh, signal),
      requestSnapshot: initial,
    };
  } catch (err) {
    signal?.throwIfAborted();
    const firstFailureReason = readRefreshFailureReason(err);
    if (firstFailureReason !== "reauth") throw err;
    await delay(REFRESH_RETRY_DELAY_MS, signal);
    const onDisk = loadOAuthProfileSnapshot(name);
    if (onDisk === null) throw missingProfile(name);
    try {
      return {
        refreshed: await refreshCodexToken(onDisk.profile.refresh, signal),
        requestSnapshot: onDisk,
      };
    } catch (retryErr) {
      if (firstFailureReason === "reauth" && readRefreshFailureReason(retryErr) === "reauth") {
        throw new RefreshTokenReusedError(name, retryErr);
      }
      throw retryErr;
    }
  }
}

const refreshQueues = new Map<string, Promise<unknown>>();

export async function getFreshToken(name: string, signal?: AbortSignal): Promise<string> {
  const prev = refreshQueues.get(name) ?? Promise.resolve();
  const run = prev.then(
    () => getFreshTokenExclusive(name, signal),
    () => getFreshTokenExclusive(name, signal),
  );
  refreshQueues.set(name, run);
  try {
    return await run;
  } finally {
    if (refreshQueues.get(name) === run) {
      refreshQueues.delete(name);
    }
  }
}

async function getFreshTokenExclusive(name: string, signal?: AbortSignal): Promise<string> {
  const initial = loadOAuthProfileSnapshot(name);
  if (initial === null) throw missingProfile(name);
  const cred = initial.profile;

  if (!isExpiredOrUnusable(cred)) {
    return cred.access;
  }

  if (name !== "openai-codex") {
    throw new Error(`Refresh not implemented for profile "${name}"`);
  }

  const { refreshed, requestSnapshot } = await refreshWithReauthConfirmation(name, initial, signal);

  const next: OAuthCredential = {
    ...requestSnapshot.profile,
    type: "oauth",
    access: refreshed.access,
    refresh: refreshed.refresh,
    expires: refreshed.expires,
    accountId:
      typeof refreshed.accountId === "string"
        ? refreshed.accountId
        : requestSnapshot.profile.accountId,
    email: requestSnapshot.profile.email,
  };
  const saved = await compareAndSaveStoredProfile(
    PROFILES_FILE,
    name,
    requestSnapshot.stored,
    next,
  );
  if (saved.status === "missing") throw missingProfile(name);
  if (saved.status === "saved") return next.access;
  const superseding = decodeOAuthCredential(saved.profile);
  if (superseding === null) throw missingProfile(name);
  return superseding.access;
}
