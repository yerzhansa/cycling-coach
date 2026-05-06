import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { spawnCapture } from "./_spawn.js";

export type OpState =
  | { state: "ready"; absolutePath: string; signedInAs: string }
  | { state: "needs-signin"; absolutePath: string }
  | {
      state: "unavailable";
      reason: "not-on-path" | "no-account" | "other";
      detail?: string;
    };

export type KeychainState = { available: boolean };

export type BackendAvailability = {
  op: OpState;
  keychain: KeychainState;
};

const DEFAULT_TIMEOUT_MS = 2000;

export async function detectBackends(): Promise<BackendAvailability> {
  return await _detectBackendsWithOverrides({});
}

export async function _detectBackendsWithOverrides(overrides: {
  opPath?: string | null;
  pathEnv?: string;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
}): Promise<BackendAvailability> {
  const platform = overrides.platform ?? process.platform;
  const timeoutMs = overrides.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const opPath =
    overrides.opPath !== undefined
      ? overrides.opPath
      : await findInPath("op", overrides.pathEnv ?? process.env.PATH ?? "");

  const op: OpState =
    opPath === null
      ? { state: "unavailable", reason: "not-on-path" }
      : await detectOpState(opPath, timeoutMs);

  const keychain: KeychainState = { available: platform === "darwin" };

  return { op, keychain };
}

async function detectOpState(opPath: string, timeoutMs: number): Promise<OpState> {
  const accountsRaw = await spawnCapture(
    opPath,
    ["account", "list", "--format=json"],
    { timeoutMs },
  );
  if (accountsRaw.timedOut) {
    return { state: "unavailable", reason: "other", detail: "timeout" };
  }
  if (accountsRaw.exitCode !== 0) {
    const detail = cleanOpStderr(accountsRaw.stderr) || "account list failed";
    return { state: "unavailable", reason: "other", detail };
  }

  let accounts: unknown;
  try {
    accounts = JSON.parse(accountsRaw.stdout);
  } catch {
    return { state: "unavailable", reason: "other", detail: "account list returned non-JSON" };
  }
  if (!Array.isArray(accounts) || accounts.length === 0) {
    return { state: "unavailable", reason: "no-account" };
  }
  const first = accounts[0] as { email?: unknown };
  const email = typeof first.email === "string" ? first.email : "";

  const vaultsRaw = await spawnCapture(
    opPath,
    ["vault", "list", "--format=json"],
    { timeoutMs },
  );
  if (vaultsRaw.timedOut) {
    return { state: "unavailable", reason: "other", detail: "timeout" };
  }
  if (vaultsRaw.exitCode === 0) {
    return { state: "ready", absolutePath: opPath, signedInAs: email };
  }
  if (/not signed in/i.test(vaultsRaw.stderr)) {
    return { state: "needs-signin", absolutePath: opPath };
  }
  const detail = cleanOpStderr(vaultsRaw.stderr) || "vault list failed";
  return { state: "unavailable", reason: "other", detail };
}

// op puts its headline on the first stderr line; everything below is context
// or a docs URL we don't want to surface in describeOpState.
const OP_LOG_DATETIME_RE = /^\[\w+\]\s+\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}\s+/;
const OP_LOG_LEVEL_RE = /^\[\w+\]\s+/;
const OP_STDERR_MAX_LEN = 240;
// Don't word-break if the boundary lands too early — we'd throw away most of
// the message just to avoid one mid-word cut.
const OP_STDERR_MIN_WORDBREAK = 80;

export function cleanOpStderr(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return "";
  let line = lines[0].replace(OP_LOG_DATETIME_RE, "").replace(OP_LOG_LEVEL_RE, "");
  if (line.length > OP_STDERR_MAX_LEN) {
    const cut = line.lastIndexOf(" ", OP_STDERR_MAX_LEN);
    line =
      (cut > OP_STDERR_MIN_WORDBREAK
        ? line.slice(0, cut)
        : line.slice(0, OP_STDERR_MAX_LEN)) + "…";
  }
  return line;
}

export async function findInPath(bin: string, pathEnv: string): Promise<string | null> {
  if (!pathEnv) return null;
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not found or not executable — try next directory
    }
  }
  return null;
}
