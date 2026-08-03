import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  AthleteHomeIdentitySchema,
  TelegramCredentialSchema,
  type AthleteHomeIdentity,
  type TelegramCredential,
} from "@enduragent/coach-contract";
import type { CredentialEncryptionPort } from "./credential-vault.js";

export const TELEGRAM_CREDENTIAL_DIRECTORY_NAME = "telegram-channel-v1" as const;
export const TELEGRAM_CREDENTIAL_FILE_NAME = "credential.bin" as const;
export const TELEGRAM_DESIRED_STATE_FILE_NAME = "desired-state.json" as const;
export const TELEGRAM_CREDENTIAL_DIRECTORY_MODE = 0o700;
export const TELEGRAM_CREDENTIAL_FILE_MODE = 0o600;

const UNSAFE_STORAGE_BACKEND = "basic_text";

export type TelegramCredentialStatus = Readonly<{
  state: "missing" | "configured" | "re-prompt" | "wrong-home";
}>;

export type TelegramDesiredState =
  | Readonly<{ state: "configured"; enabled: boolean }>
  | Readonly<{ state: "missing" | "re-prompt" | "wrong-home"; enabled: false }>;

export type TelegramCredentialWriteResult =
  | Readonly<{ status: "configured" }>
  | Readonly<{
      status: "refused";
      reason:
        | "invalid-input"
        | "wrong-home"
        | "encryption-unavailable"
        | "unsafe-backend"
        | "storage-failed";
    }>;

export type TelegramCredentialApplyResult =
  | Readonly<{ status: "applied" }>
  | Readonly<{
      status: "refused";
      reason:
        | "missing"
        | "wrong-home"
        | "encryption-unavailable"
        | "unsafe-backend"
        | "re-prompt"
        | "runtime-unavailable";
    }>;

export type TelegramCredentialDeleteResult =
  | Readonly<{ status: "deleted"; cleanupPending: boolean }>
  | Readonly<{
      status: "refused";
      reason:
        | "not-found"
        | "wrong-home"
        | "encryption-unavailable"
        | "unsafe-backend"
        | "storage-failed";
    }>;

export type TelegramDesiredStateWriteResult =
  | Readonly<{ status: "stored"; enabled: boolean }>
  | Readonly<{ status: "refused"; reason: "invalid-input" | "storage-failed" }>;

export interface TelegramCredentialVault {
  credentialStatus(): Promise<TelegramCredentialStatus>;
  writeCredential(input: {
    readonly token: string;
    readonly authenticatedAthleteHome: AthleteHomeIdentity;
  }): Promise<TelegramCredentialWriteResult>;
  applyStoredCredential(
    authenticatedAthleteHome: AthleteHomeIdentity,
    applyCredential: (token: TelegramCredential) => Promise<void>,
  ): Promise<TelegramCredentialApplyResult>;
  deleteCredential(): Promise<TelegramCredentialDeleteResult>;
  desiredState(): Promise<TelegramDesiredState>;
  setDesiredState(enabled: boolean): Promise<TelegramDesiredStateWriteResult>;
}

export interface TelegramCredentialVaultOptions {
  readonly root: string;
  readonly athleteHome: AthleteHomeIdentity;
  readonly encryption: CredentialEncryptionPort;
  readonly createId?: () => string;
  readonly renameFile?: typeof rename;
  readonly removeFile?: typeof rm;
  readonly syncDirectory?: (root: string) => Promise<void>;
}

interface TelegramCredentialRecord {
  readonly schemaVersion: 1;
  readonly athleteHome: AthleteHomeIdentity;
  readonly token: TelegramCredential;
}

interface TelegramDesiredStateRecord {
  readonly schemaVersion: 1;
  readonly athleteHome: AthleteHomeIdentity;
  readonly enabled: boolean;
}

type EncryptionRefusal = "encryption-unavailable" | "unsafe-backend";

type ReadCredential =
  | { readonly state: "configured"; readonly token: TelegramCredential }
  | { readonly state: "missing" }
  | { readonly state: "wrong-home" }
  | {
      readonly state: "re-prompt";
      readonly reason: EncryptionRefusal | "decrypt-failed" | "storage-failed";
    };

type TargetState = "missing" | "valid" | "unsafe";

function permissions(mode: number): number {
  return mode & 0o777;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function parseToken(value: unknown): TelegramCredential | undefined {
  const parsed = TelegramCredentialSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function parseAthleteHome(value: unknown): AthleteHomeIdentity | undefined {
  const parsed = AthleteHomeIdentitySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function parseCredentialRecord(value: string): TelegramCredentialRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (!exactKeys(record, ["athleteHome", "schemaVersion", "token"])) return undefined;
  const athleteHome = parseAthleteHome(record.athleteHome);
  const token = parseToken(record.token);
  if (record.schemaVersion !== 1 || athleteHome === undefined || token === undefined) {
    return undefined;
  }
  return { schemaVersion: 1, athleteHome, token };
}

function parseDesiredStateRecord(value: string): TelegramDesiredStateRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (!exactKeys(record, ["athleteHome", "enabled", "schemaVersion"])) return undefined;
  const athleteHome = parseAthleteHome(record.athleteHome);
  if (
    record.schemaVersion !== 1 ||
    athleteHome === undefined ||
    typeof record.enabled !== "boolean"
  ) {
    return undefined;
  }
  return { schemaVersion: 1, athleteHome, enabled: record.enabled };
}

function encryptionRefusal(encryption: CredentialEncryptionPort): EncryptionRefusal | undefined {
  try {
    if (!encryption.isEncryptionAvailable()) return "encryption-unavailable";
    if (encryption.getSelectedStorageBackend?.() === UNSAFE_STORAGE_BACKEND) {
      return "unsafe-backend";
    }
    return undefined;
  } catch {
    return "encryption-unavailable";
  }
}

async function secureDirectoryState(root: string): Promise<"missing" | "secure" | "unsafe"> {
  try {
    const entry = await lstat(root);
    return entry.isDirectory() &&
      !entry.isSymbolicLink() &&
      permissions(entry.mode) === TELEGRAM_CREDENTIAL_DIRECTORY_MODE
      ? "secure"
      : "unsafe";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unsafe";
  }
}

async function ensureSecureDirectory(root: string): Promise<boolean> {
  try {
    await mkdir(root, { recursive: true, mode: TELEGRAM_CREDENTIAL_DIRECTORY_MODE });
    return (await secureDirectoryState(root)) === "secure";
  } catch {
    return false;
  }
}

async function targetState(path: string): Promise<TargetState> {
  try {
    const entry = await lstat(path);
    return entry.isFile() &&
      !entry.isSymbolicLink() &&
      entry.size > 0 &&
      permissions(entry.mode) === TELEGRAM_CREDENTIAL_FILE_MODE
      ? "valid"
      : "unsafe";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unsafe";
  }
}

export function createTelegramCredentialVault(
  options: TelegramCredentialVaultOptions,
): TelegramCredentialVault {
  if (typeof options.root !== "string" || options.root.length === 0) {
    throw new TypeError("invalid Telegram credential vault root");
  }
  const athleteHome = AthleteHomeIdentitySchema.parse(options.athleteHome);

  const createId = options.createId ?? randomUUID;
  const renameFile = options.renameFile ?? rename;
  const removeFile = options.removeFile ?? rm;
  const syncDirectory =
    options.syncDirectory ??
    (async (root: string): Promise<void> => {
      const directory = await open(root, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    });
  let operationQueue = Promise.resolve();

  const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = operationQueue.then(operation, operation);
    operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const cleanupTombstones = async (): Promise<void> => {
    if ((await secureDirectoryState(options.root)) !== "secure") return;
    let entries: readonly string[];
    try {
      entries = await readdir(options.root);
    } catch {
      return;
    }
    const prefix = `.${TELEGRAM_CREDENTIAL_FILE_NAME}.`;
    let cleaned = false;
    for (const entry of entries) {
      if (!entry.startsWith(prefix) || !entry.endsWith(".deleted")) continue;
      try {
        await removeFile(join(options.root, entry), { force: true });
        cleaned = true;
      } catch {}
    }
    if (cleaned) await syncDirectory(options.root).catch(() => undefined);
  };

  const atomicReplace = async (fileName: string, contents: string | Buffer): Promise<boolean> => {
    if (!(await ensureSecureDirectory(options.root))) return false;
    const target = join(options.root, fileName);
    if ((await targetState(target)) === "unsafe") return false;
    const temporary = join(options.root, `.${fileName}.${createId()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", TELEGRAM_CREDENTIAL_FILE_MODE);
      await handle.writeFile(contents);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await renameFile(temporary, target);
      await syncDirectory(options.root);
      return true;
    } catch {
      try {
        await handle?.close();
      } catch {}
      await removeFile(temporary, { force: true }).catch(() => undefined);
      return false;
    }
  };

  const readCredential = async (): Promise<ReadCredential> => {
    const encryptionFailure = encryptionRefusal(options.encryption);
    if (encryptionFailure !== undefined) {
      return { state: "re-prompt", reason: encryptionFailure };
    }
    const directory = await secureDirectoryState(options.root);
    if (directory === "missing") return { state: "missing" };
    if (directory === "unsafe") return { state: "re-prompt", reason: "storage-failed" };
    const path = join(options.root, TELEGRAM_CREDENTIAL_FILE_NAME);
    const file = await targetState(path);
    if (file === "missing") return { state: "missing" };
    if (file === "unsafe") return { state: "re-prompt", reason: "storage-failed" };
    let encrypted: Buffer | undefined;
    try {
      encrypted = await readFile(path);
      const record = parseCredentialRecord(options.encryption.decryptString(encrypted));
      if (record === undefined) return { state: "re-prompt", reason: "decrypt-failed" };
      if (record.athleteHome !== athleteHome) return { state: "wrong-home" };
      return { state: "configured", token: record.token };
    } catch {
      return { state: "re-prompt", reason: "decrypt-failed" };
    } finally {
      encrypted?.fill(0);
    }
  };

  const removeStoredCredential = async (): Promise<
    "deleted" | "cleanup-pending" | "retained" | "uncertain"
  > => {
    if ((await secureDirectoryState(options.root)) !== "secure") return "retained";
    const target = join(options.root, TELEGRAM_CREDENTIAL_FILE_NAME);
    if ((await targetState(target)) !== "valid") return "retained";
    const tombstone = join(options.root, `.${TELEGRAM_CREDENTIAL_FILE_NAME}.${createId()}.deleted`);
    try {
      await renameFile(target, tombstone);
    } catch {
      return "retained";
    }
    try {
      await syncDirectory(options.root);
    } catch {
      try {
        await renameFile(tombstone, target);
        await syncDirectory(options.root);
        return "retained";
      } catch {
        return "uncertain";
      }
    }
    try {
      await removeFile(tombstone, { force: true });
      await syncDirectory(options.root);
      return "deleted";
    } catch {
      return "cleanup-pending";
    }
  };

  const readDesiredState = async (): Promise<TelegramDesiredState> => {
    const directory = await secureDirectoryState(options.root);
    if (directory === "missing") return { state: "missing", enabled: false };
    if (directory === "unsafe") return { state: "re-prompt", enabled: false };
    const path = join(options.root, TELEGRAM_DESIRED_STATE_FILE_NAME);
    const file = await targetState(path);
    if (file === "missing") return { state: "missing", enabled: false };
    if (file === "unsafe") return { state: "re-prompt", enabled: false };
    try {
      const record = parseDesiredStateRecord(await readFile(path, "utf8"));
      if (record === undefined) return { state: "re-prompt", enabled: false };
      if (record.athleteHome !== athleteHome) return { state: "wrong-home", enabled: false };
      return { state: "configured", enabled: record.enabled };
    } catch {
      return { state: "re-prompt", enabled: false };
    }
  };

  return {
    credentialStatus(): Promise<TelegramCredentialStatus> {
      return exclusive(async () => {
        await cleanupTombstones();
        const credential = await readCredential();
        return { state: credential.state };
      });
    },

    writeCredential(input): Promise<TelegramCredentialWriteResult> {
      return exclusive(async () => {
        const authenticatedAthleteHome = parseAthleteHome(input?.authenticatedAthleteHome);
        if (authenticatedAthleteHome === undefined || authenticatedAthleteHome !== athleteHome) {
          return { status: "refused", reason: "wrong-home" };
        }
        const token = parseToken(input?.token);
        if (token === undefined) return { status: "refused", reason: "invalid-input" };
        const encryptionFailure = encryptionRefusal(options.encryption);
        if (encryptionFailure !== undefined) {
          return { status: "refused", reason: encryptionFailure };
        }
        await cleanupTombstones();
        let encrypted: Buffer | undefined;
        try {
          encrypted = options.encryption.encryptString(
            JSON.stringify({ schemaVersion: 1, athleteHome, token }),
          );
          if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) throw new TypeError();
          if (!(await atomicReplace(TELEGRAM_CREDENTIAL_FILE_NAME, encrypted))) {
            return { status: "refused", reason: "storage-failed" };
          }
          return { status: "configured" };
        } catch {
          return { status: "refused", reason: "storage-failed" };
        } finally {
          encrypted?.fill(0);
        }
      });
    },

    applyStoredCredential(
      authenticatedAthleteHome,
      applyCredential,
    ): Promise<TelegramCredentialApplyResult> {
      return exclusive(async () => {
        const authenticated = parseAthleteHome(authenticatedAthleteHome);
        if (authenticated === undefined || authenticated !== athleteHome) {
          return { status: "refused", reason: "wrong-home" };
        }
        await cleanupTombstones();
        const credential = await readCredential();
        if (credential.state === "missing") return { status: "refused", reason: "missing" };
        if (credential.state === "wrong-home") {
          return { status: "refused", reason: "wrong-home" };
        }
        if (credential.state === "re-prompt") {
          return {
            status: "refused",
            reason:
              credential.reason === "encryption-unavailable" ||
              credential.reason === "unsafe-backend"
                ? credential.reason
                : "re-prompt",
          };
        }
        if (typeof applyCredential !== "function") {
          return { status: "refused", reason: "runtime-unavailable" };
        }
        try {
          await applyCredential(credential.token);
          return { status: "applied" };
        } catch {
          return { status: "refused", reason: "runtime-unavailable" };
        }
      });
    },

    deleteCredential(): Promise<TelegramCredentialDeleteResult> {
      return exclusive(async () => {
        await cleanupTombstones();
        const credential = await readCredential();
        if (credential.state === "missing") return { status: "refused", reason: "not-found" };
        if (credential.state === "wrong-home") {
          return { status: "refused", reason: "wrong-home" };
        }
        if (
          credential.state === "re-prompt" &&
          (credential.reason === "encryption-unavailable" || credential.reason === "unsafe-backend")
        ) {
          return { status: "refused", reason: credential.reason };
        }
        const removed = await removeStoredCredential();
        if (removed === "deleted" || removed === "cleanup-pending") {
          return { status: "deleted", cleanupPending: removed === "cleanup-pending" };
        }
        return { status: "refused", reason: "storage-failed" };
      });
    },

    desiredState(): Promise<TelegramDesiredState> {
      return exclusive(async () => readDesiredState());
    },

    setDesiredState(enabled): Promise<TelegramDesiredStateWriteResult> {
      return exclusive(async () => {
        if (typeof enabled !== "boolean") {
          return { status: "refused", reason: "invalid-input" };
        }
        const stored = await atomicReplace(
          TELEGRAM_DESIRED_STATE_FILE_NAME,
          `${JSON.stringify({ schemaVersion: 1, athleteHome, enabled })}\n`,
        );
        return stored
          ? { status: "stored", enabled }
          : { status: "refused", reason: "storage-failed" };
      });
    },
  };
}
