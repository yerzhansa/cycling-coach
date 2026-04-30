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
    const detail = accountsRaw.stderr.slice(-200).trim();
    return { state: "unavailable", reason: "other", detail: detail || "account list failed" };
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
  const detail = vaultsRaw.stderr.slice(-200).trim();
  return { state: "unavailable", reason: "other", detail: detail || "vault list failed" };
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
