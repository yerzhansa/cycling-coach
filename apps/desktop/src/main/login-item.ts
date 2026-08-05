import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { App, LoginItemSettings } from "electron";
import {
  durablyReplaceReversible,
  type ReversibleDurableReplaceOutcome,
} from "./durable-atomic-replace.js";

export const CLEAN_LOGIN_ITEM_STATUSES = ["not-found", "not-registered"] as const;
export const BACKGROUND_AT_LOGIN_PREFERENCE_DIRECTORY_NAME = "desktop-preferences-v1" as const;
export const BACKGROUND_AT_LOGIN_PREFERENCE_FILE_NAME = "background-at-login.json" as const;
export const LOGIN_ITEM_PREFERENCE_DIRECTORY_MODE = 0o700;
export const LOGIN_ITEM_PREFERENCE_FILE_MODE = 0o600;

const MAX_PREFERENCE_FILE_BYTES = 1_024;

export type CleanLoginItemStatus = (typeof CLEAN_LOGIN_ITEM_STATUSES)[number];

export interface LoginItemResidencyState {
  readonly openAtLogin: boolean;
  readonly executableWillLaunchAtLogin: boolean;
  readonly status: LoginItemSettings["status"];
}

export type LoginItemAppPort = Pick<App, "getLoginItemSettings" | "setLoginItemSettings">;
export type LoginLaunchAppPort = Pick<App, "getLoginItemSettings">;

export type BackgroundAtLoginPreference =
  | Readonly<{
      state: "configured";
      enabled: boolean;
      loginLaunchBehavior?: "background";
    }>
  | Readonly<{ state: "unavailable" | "uncertain"; enabled: false }>;

export type BackgroundAtLoginPreferenceWriteResult =
  | Readonly<{ status: "stored"; enabled: boolean }>
  | Readonly<{ status: "refused" }>
  | Readonly<{ status: "uncertain" }>;

export interface BackgroundAtLoginPreferenceStore {
  read(): Promise<BackgroundAtLoginPreference>;
  set(enabled: boolean): Promise<BackgroundAtLoginPreferenceWriteResult>;
}

export interface CreateBackgroundAtLoginPreferenceStoreInput {
  readonly root: string;
  readonly createId?: () => string;
  readonly renameFile?: typeof rename;
  readonly removeFile?: typeof rm;
  readonly syncDirectory?: (root: string) => Promise<void>;
  readonly syncParentDirectory?: (root: string) => Promise<void>;
}

interface LegacyBackgroundAtLoginPreferenceRecord {
  readonly schemaVersion: 1;
  readonly enabled: boolean;
}

interface BackgroundAtLoginPreferenceRecord {
  readonly schemaVersion: 2;
  readonly enabled: boolean;
  readonly loginLaunchBehavior: "background";
}

type StoredBackgroundAtLoginPreferenceRecord =
  | LegacyBackgroundAtLoginPreferenceRecord
  | BackgroundAtLoginPreferenceRecord;

function permissions(mode: number): number {
  return mode & 0o777;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function assertOwner(metadata: Stats, mode: number): void {
  if (
    metadata.isSymbolicLink() ||
    permissions(metadata.mode) !== mode ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid())
  ) {
    throw new TypeError("unsafe login preference path");
  }
}

function parsePreference(contents: string): StoredBackgroundAtLoginPreferenceRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (record.schemaVersion === 1) {
    if (
      keys.length !== 2 ||
      keys[0] !== "enabled" ||
      keys[1] !== "schemaVersion" ||
      typeof record.enabled !== "boolean"
    ) {
      return undefined;
    }
    return { schemaVersion: 1, enabled: record.enabled };
  }
  if (
    record.schemaVersion !== 2 ||
    keys.length !== 3 ||
    keys[0] !== "enabled" ||
    keys[1] !== "loginLaunchBehavior" ||
    keys[2] !== "schemaVersion" ||
    typeof record.enabled !== "boolean" ||
    record.loginLaunchBehavior !== "background"
  ) {
    return undefined;
  }
  return {
    schemaVersion: 2,
    enabled: record.enabled,
    loginLaunchBehavior: "background",
  };
}

export function createBackgroundAtLoginPreferenceStore(
  input: CreateBackgroundAtLoginPreferenceStoreInput,
): BackgroundAtLoginPreferenceStore {
  const target = join(input.root, BACKGROUND_AT_LOGIN_PREFERENCE_FILE_NAME);
  const createId = input.createId ?? randomUUID;
  let namespaceState: "pending" | "verified" | "uncertain" = "pending";
  let parentDirectoryVerified = false;
  let pending: Promise<void> = Promise.resolve();

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = pending.then(operation);
    pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const defaultSynchronizeDirectory = async (root: string): Promise<void> => {
    const directory = await open(root, "r");
    try {
      await directory.sync();
    } catch (error) {
      await directory.close().catch(() => undefined);
      throw error;
    }
    await directory.close().catch(() => undefined);
  };
  const synchronizeDirectory = input.syncDirectory ?? defaultSynchronizeDirectory;
  const synchronizeParentDirectory = input.syncParentDirectory ?? defaultSynchronizeDirectory;
  const ownedTransient = (entry: string): boolean => {
    const prefix = `.${BACKGROUND_AT_LOGIN_PREFERENCE_FILE_NAME}.`;
    if (!entry.startsWith(prefix)) return false;
    const suffix = entry.endsWith(".tmp")
      ? ".tmp"
      : entry.endsWith(".deleted")
        ? ".deleted"
        : undefined;
    if (suffix === undefined) return false;
    return /^[A-Za-z0-9-]{1,128}$/.test(entry.slice(prefix.length, -suffix.length));
  };
  const reconcileNamespace = async (): Promise<boolean> => {
    if (namespaceState === "verified") return true;
    if (namespaceState === "uncertain") return false;
    try {
      let rootMetadata;
      try {
        rootMetadata = await lstat(input.root);
      } catch (error) {
        if (isMissing(error)) {
          namespaceState = "verified";
          return true;
        }
        throw error;
      }
      if (!rootMetadata.isDirectory()) throw new TypeError("invalid login preference root");
      assertOwner(rootMetadata, LOGIN_ITEM_PREFERENCE_DIRECTORY_MODE);
      for (const entry of await readdir(input.root)) {
        if (ownedTransient(entry)) {
          await (input.removeFile ?? rm)(join(input.root, entry), { force: true });
        }
      }
      await synchronizeDirectory(input.root);
      namespaceState = "verified";
      return true;
    } catch {
      namespaceState = "uncertain";
      return false;
    }
  };
  const readRawRecord = async (): Promise<Buffer | undefined> => {
    let rootMetadata;
    try {
      rootMetadata = await lstat(input.root);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    if (!rootMetadata.isDirectory()) throw new TypeError("invalid login preference root");
    assertOwner(rootMetadata, LOGIN_ITEM_PREFERENCE_DIRECTORY_MODE);
    let before;
    try {
      before = await lstat(target);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    if (!before.isFile() || before.size > MAX_PREFERENCE_FILE_BYTES) {
      throw new TypeError("invalid login preference file");
    }
    assertOwner(before, LOGIN_ITEM_PREFERENCE_FILE_MODE);
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size > MAX_PREFERENCE_FILE_BYTES
      ) {
        throw new TypeError("login preference changed while opening");
      }
      assertOwner(opened, LOGIN_ITEM_PREFERENCE_FILE_MODE);
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  };
  const readRecord = async (): Promise<StoredBackgroundAtLoginPreferenceRecord> => {
    const contents = await readRawRecord();
    if (contents === undefined) return { schemaVersion: 1, enabled: false };
    try {
      const record = parsePreference(contents.toString("utf8"));
      if (record === undefined) throw new TypeError("invalid login preference record");
      return record;
    } finally {
      contents.fill(0);
    }
  };
  const writeRecord = async (
    record: BackgroundAtLoginPreferenceRecord,
  ): Promise<ReversibleDurableReplaceOutcome> => {
    await mkdir(input.root, { recursive: true, mode: LOGIN_ITEM_PREFERENCE_DIRECTORY_MODE });
    const rootMetadata = await lstat(input.root);
    if (!rootMetadata.isDirectory()) throw new TypeError("invalid login preference root");
    assertOwner(rootMetadata, LOGIN_ITEM_PREFERENCE_DIRECTORY_MODE);
    if (!parentDirectoryVerified) {
      await synchronizeParentDirectory(dirname(input.root));
      parentDirectoryVerified = true;
    }
    try {
      const existing = await lstat(target);
      if (!existing.isFile()) throw new TypeError("invalid login preference target");
      assertOwner(existing, LOGIN_ITEM_PREFERENCE_FILE_MODE);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const id = createId();
    if (!/^[A-Za-z0-9-]{1,128}$/.test(id)) throw new TypeError("invalid temporary file id");
    let previous: Buffer | undefined;
    const candidate = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    try {
      previous = await readRawRecord();
      return await durablyReplaceReversible({
        root: input.root,
        fileName: BACKGROUND_AT_LOGIN_PREFERENCE_FILE_NAME,
        contents: candidate,
        previousContents: previous,
        mode: LOGIN_ITEM_PREFERENCE_FILE_MODE,
        createId: () => id,
        renameFile: input.renameFile,
        removeFile: input.removeFile,
        syncDirectory: input.syncDirectory,
      });
    } finally {
      previous?.fill(0);
      candidate.fill(0);
    }
  };

  return {
    read() {
      return serialize(async () => {
        if (!(await reconcileNamespace())) return { state: "uncertain", enabled: false };
        try {
          const record = await readRecord();
          return record.schemaVersion === 2
            ? {
                state: "configured",
                enabled: record.enabled,
                loginLaunchBehavior: record.loginLaunchBehavior,
              }
            : { state: "configured", enabled: record.enabled };
        } catch {
          return { state: "unavailable", enabled: false };
        }
      });
    },
    set(enabled) {
      return serialize(async () => {
        if (typeof enabled !== "boolean") return { status: "refused" };
        if (!(await reconcileNamespace())) return { status: "uncertain" };
        try {
          const current = await readRecord();
          const currentProtectsLoginLaunch =
            current.schemaVersion === 2 || current.enabled === true;
          if (current.enabled === enabled && currentProtectsLoginLaunch) {
            namespaceState = "verified";
            return { status: "stored", enabled };
          }
          const stored = await writeRecord({
            schemaVersion: 2,
            enabled,
            loginLaunchBehavior: "background",
          });
          if (stored.state === "applied") {
            namespaceState = "verified";
            return { status: "stored", enabled };
          }
          if (stored.state === "refused") {
            namespaceState = "verified";
            return { status: "refused" };
          }
          namespaceState = "uncertain";
          return { status: "uncertain" };
        } catch {
          return { status: "refused" };
        }
      });
    },
  };
}

export async function shouldStartInBackgroundAtLogin(
  app: LoginLaunchAppPort,
  preference: Pick<BackgroundAtLoginPreferenceStore, "read">,
): Promise<boolean> {
  if (app.getLoginItemSettings().wasOpenedAtLogin !== true) return false;
  const stored = await preference.read();
  if (stored.state === "uncertain") return true;
  return (
    stored.state === "configured" && (stored.enabled || stored.loginLaunchBehavior === "background")
  );
}

export function readLoginItemResidency(app: LoginItemAppPort): LoginItemResidencyState {
  const settings = app.getLoginItemSettings();
  return {
    openAtLogin: settings.openAtLogin,
    executableWillLaunchAtLogin: settings.executableWillLaunchAtLogin,
    status: settings.status,
  };
}

export function setLoginItemResidency(
  app: LoginItemAppPort,
  openAtLogin: boolean,
): LoginItemResidencyState {
  app.setLoginItemSettings({ openAtLogin });
  return readLoginItemResidency(app);
}

export function isCleanUnregisteredLoginItem(
  state: LoginItemResidencyState,
): state is LoginItemResidencyState & {
  readonly openAtLogin: false;
  readonly executableWillLaunchAtLogin: false;
  readonly status: CleanLoginItemStatus;
} {
  return (
    state.openAtLogin === false &&
    state.executableWillLaunchAtLogin === false &&
    CLEAN_LOGIN_ITEM_STATUSES.includes(state.status as CleanLoginItemStatus)
  );
}
