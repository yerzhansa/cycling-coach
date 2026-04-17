import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { refreshOpenAICodexToken } from "@mariozechner/pi-ai/oauth";

// ============================================================================
// TYPES
// ============================================================================

export interface OAuthCredential {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  email?: string;
}

export class RefreshTokenReusedError extends Error {
  constructor(public readonly profile: string, cause: unknown) {
    super(
      `OAuth refresh token for "${profile}" has been invalidated. Re-run \`npm run setup\` or \`cycling-coach setup\` to reauthenticate.`,
    );
    this.name = "RefreshTokenReusedError";
    this.cause = cause;
  }
}

// ============================================================================
// STORAGE
// ============================================================================

const PROFILES_FILE = join(homedir(), ".cycling-coach", "auth-profiles.json");
const REFRESH_THRESHOLD_MS = 5 * 60 * 1000;

type ProfilesFile = Record<string, OAuthCredential>;

function readAll(): ProfilesFile {
  if (!existsSync(PROFILES_FILE)) return {};
  try {
    const raw = readFileSync(PROFILES_FILE, "utf-8");
    return JSON.parse(raw) as ProfilesFile;
  } catch {
    return {};
  }
}

function writeAll(profiles: ProfilesFile): void {
  writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, 2), { mode: 0o600 });
  // Ensure perms on existing files created before this write
  chmodSync(PROFILES_FILE, 0o600);
}

export function loadProfile(name: string): OAuthCredential | null {
  const all = readAll();
  return all[name] ?? null;
}

export function saveProfile(name: string, cred: OAuthCredential): void {
  const all = readAll();
  all[name] = cred;
  writeAll(all);
}

function isExpiredOrUnusable(cred: OAuthCredential): boolean {
  if (!Number.isFinite(cred.expires)) return true;
  return Date.now() > cred.expires - REFRESH_THRESHOLD_MS;
}

// ============================================================================
// REFRESH
// ============================================================================

export async function getFreshToken(name: string): Promise<string> {
  const cred = loadProfile(name);
  if (!cred) {
    throw new Error(`No OAuth profile "${name}". Run \`cycling-coach setup\` to create one.`);
  }

  if (!isExpiredOrUnusable(cred)) {
    return cred.access;
  }

  if (name !== "openai-codex") {
    throw new Error(`Refresh not implemented for profile "${name}"`);
  }

  let refreshed;
  try {
    refreshed = await refreshOpenAICodexToken(cred.refresh);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/refresh.*reuse|invalid.*refresh|Failed to refresh/i.test(msg)) {
      throw new RefreshTokenReusedError(name, err);
    }
    throw err;
  }

  const next: OAuthCredential = {
    type: "oauth",
    access: refreshed.access,
    refresh: refreshed.refresh,
    expires: refreshed.expires,
    accountId: typeof refreshed.accountId === "string" ? refreshed.accountId : cred.accountId,
    email: cred.email,
  };
  saveProfile(name, next);
  return next.access;
}
