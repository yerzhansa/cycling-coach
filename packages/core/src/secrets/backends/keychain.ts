import { homedir } from "node:os";
import { join } from "node:path";
import type { SecretRef } from "../types.js";
import { spawnCapture, spawnStdin } from "./_spawn.js";

const DEFAULT_SECURITY_PATH = "/usr/bin/security";
const DEFAULT_TIMEOUT_MS = 30_000;
const LOGIN_KEYCHAIN_TIMEOUT_MS = 5_000;
const SERVICE_NAME = "cycling-coach";

const SECURITY_I_ERROR_RE = /^\S+:\s+returned (-\d+)/m;

export class KeychainUnsafeValueError extends Error {
  constructor() {
    super(
      "Keychain backend cannot store values containing whitespace, quotes, backslashes, or null bytes. " +
        "Use env var or plain YAML for this secret.",
    );
    this.name = "KeychainUnsafeValueError";
  }
}

export class KeychainUnsupportedPlatformError extends Error {
  constructor(platform: string) {
    super(
      `Keychain backend is only supported on macOS; current platform is "${platform}".`,
    );
    this.name = "KeychainUnsupportedPlatformError";
  }
}

export type KeychainOverrides = {
  securityPath?: string;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
};

export async function keychainLoginPath(
  overrides?: KeychainOverrides,
): Promise<string> {
  const securityPath = overrides?.securityPath ?? DEFAULT_SECURITY_PATH;
  const timeoutMs = overrides?.timeoutMs ?? LOGIN_KEYCHAIN_TIMEOUT_MS;
  const fallback = join(homedir(), "Library", "Keychains", "login.keychain-db");

  const res = await spawnCapture(securityPath, ["login-keychain"], {
    timeoutMs,
  });
  if (res.timedOut || res.exitCode !== 0) {
    console.warn(
      `[keychain] security login-keychain failed (${res.timedOut ? "timeout" : `exit ${res.exitCode}`}); using fallback path ${fallback}.`,
    );
    return fallback;
  }
  const parsed = parseLoginKeychainOutput(res.stdout);
  if (parsed === null) {
    console.warn(
      `[keychain] Could not parse login-keychain output; using fallback path ${fallback}.`,
    );
    return fallback;
  }
  return parsed;
}

function parseLoginKeychainOutput(raw: string): string | null {
  let s = raw.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    s = s.slice(1, -1);
  }
  if (!s.startsWith("/")) return null;
  if (!s.endsWith(".keychain") && !s.endsWith(".keychain-db")) return null;
  return s;
}

export async function keychainItemExists(
  field: string,
  keychainPath: string,
  overrides?: KeychainOverrides,
): Promise<boolean> {
  const securityPath = overrides?.securityPath ?? DEFAULT_SECURITY_PATH;
  const timeoutMs = overrides?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const res = await spawnCapture(
    securityPath,
    ["find-generic-password", "-s", SERVICE_NAME, "-a", field, keychainPath],
    { timeoutMs },
  );
  if (res.timedOut) {
    throw new Error(
      `security find-generic-password timed out after ${timeoutMs}ms.`,
    );
  }
  return res.exitCode === 0;
}

export async function keychainItemUpsert(
  field: string,
  value: string,
  keychainPath: string,
  overrides?: KeychainOverrides,
): Promise<void> {
  const platform = overrides?.platform ?? process.platform;
  if (platform !== "darwin") {
    throw new KeychainUnsupportedPlatformError(platform);
  }
  assertKeychainSafeValue(value);

  const securityPath = overrides?.securityPath ?? DEFAULT_SECURITY_PATH;
  const timeoutMs = overrides?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const innerCmd = `add-generic-password -U -s ${SERVICE_NAME} -a ${field} -w ${value} ${keychainPath}\n\n`;
  const res = await spawnStdin(securityPath, ["-i"], innerCmd, { timeoutMs });
  if (res.timedOut) {
    throw new Error(`security -i timed out after ${timeoutMs}ms.`);
  }
  const combined = `${res.stdout}${res.stderr}`;
  const match = SECURITY_I_ERROR_RE.exec(combined);
  if (match) {
    throw new Error(`keychain upsert failed (OSStatus ${match[1]}).`);
  }
  if (res.exitCode !== 0) {
    throw new Error(
      `security -i exited ${res.exitCode}: ${res.stderr.slice(-200).trim()}`,
    );
  }
}

export async function keychainItemDelete(
  field: string,
  keychainPath: string,
  overrides?: KeychainOverrides,
): Promise<{ deleted: boolean }> {
  const securityPath = overrides?.securityPath ?? DEFAULT_SECURITY_PATH;
  const timeoutMs = overrides?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const res = await spawnCapture(
    securityPath,
    ["delete-generic-password", "-s", SERVICE_NAME, "-a", field, keychainPath],
    { timeoutMs },
  );
  if (res.timedOut) {
    throw new Error(
      `security delete-generic-password timed out after ${timeoutMs}ms.`,
    );
  }
  if (res.exitCode === 0) {
    return { deleted: true };
  }
  if (res.exitCode === 44 || /could not be found|not found/i.test(res.stderr)) {
    return { deleted: false };
  }
  throw new Error(
    `security delete-generic-password failed (exit ${res.exitCode}): ${res.stderr.slice(-200).trim()}`,
  );
}

export function keychainSecretRef(
  field: string,
  keychainPath: string,
): SecretRef {
  return {
    source: "exec",
    command: DEFAULT_SECURITY_PATH,
    args: [
      "find-generic-password",
      "-w",
      "-s",
      SERVICE_NAME,
      "-a",
      field,
      keychainPath,
    ],
  };
}

const NULL_BYTE = String.fromCharCode(0);

export function assertKeychainSafeValue(value: string): void {
  // Null byte kept out of the regex to avoid oxlint's no-control-regex rule.
  if (/[\s"\\]/.test(value) || value.includes(NULL_BYTE)) {
    throw new KeychainUnsafeValueError();
  }
}
