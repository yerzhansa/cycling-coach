import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { App, LoginItemSettings } from "electron";

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
  | Readonly<{ state: "configured"; enabled: boolean }>
  | Readonly<{ state: "unavailable"; enabled: false }>;

export type BackgroundAtLoginPreferenceWriteResult =
  | Readonly<{ status: "stored"; enabled: boolean }>
  | Readonly<{ status: "refused" }>;

export interface BackgroundAtLoginPreferenceStore {
  read(): Promise<BackgroundAtLoginPreference>;
  set(enabled: boolean): Promise<BackgroundAtLoginPreferenceWriteResult>;
}

export interface CreateBackgroundAtLoginPreferenceStoreInput {
  readonly root: string;
  readonly createId?: () => string;
}

interface BackgroundAtLoginPreferenceRecord {
  readonly schemaVersion: 1;
  readonly enabled: boolean;
}

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

function parsePreference(contents: string): BackgroundAtLoginPreferenceRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "enabled" ||
    keys[1] !== "schemaVersion" ||
    record.schemaVersion !== 1 ||
    typeof record.enabled !== "boolean"
  ) {
    return undefined;
  }
  return { schemaVersion: 1, enabled: record.enabled };
}

export function createBackgroundAtLoginPreferenceStore(
  input: CreateBackgroundAtLoginPreferenceStoreInput,
): BackgroundAtLoginPreferenceStore {
  const target = join(input.root, BACKGROUND_AT_LOGIN_PREFERENCE_FILE_NAME);
  const createId = input.createId ?? randomUUID;
  let pending: Promise<void> = Promise.resolve();

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = pending.then(operation);
    pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const readRecord = async (): Promise<BackgroundAtLoginPreferenceRecord> => {
    let rootMetadata;
    try {
      rootMetadata = await lstat(input.root);
    } catch (error) {
      if (isMissing(error)) return { schemaVersion: 1, enabled: false };
      throw error;
    }
    if (!rootMetadata.isDirectory()) throw new TypeError("invalid login preference root");
    assertOwner(rootMetadata, LOGIN_ITEM_PREFERENCE_DIRECTORY_MODE);
    let before;
    try {
      before = await lstat(target);
    } catch (error) {
      if (isMissing(error)) return { schemaVersion: 1, enabled: false };
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
      const record = parsePreference(await handle.readFile("utf8"));
      if (record === undefined) throw new TypeError("invalid login preference record");
      return record;
    } finally {
      await handle.close();
    }
  };
  const writeRecord = async (record: BackgroundAtLoginPreferenceRecord): Promise<void> => {
    await mkdir(input.root, { recursive: true, mode: LOGIN_ITEM_PREFERENCE_DIRECTORY_MODE });
    const rootMetadata = await lstat(input.root);
    if (!rootMetadata.isDirectory()) throw new TypeError("invalid login preference root");
    assertOwner(rootMetadata, LOGIN_ITEM_PREFERENCE_DIRECTORY_MODE);
    try {
      const existing = await lstat(target);
      if (!existing.isFile()) throw new TypeError("invalid login preference target");
      assertOwner(existing, LOGIN_ITEM_PREFERENCE_FILE_MODE);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const id = createId();
    if (!/^[A-Za-z0-9-]{1,128}$/.test(id)) throw new TypeError("invalid temporary file id");
    const temporary = join(input.root, `.${BACKGROUND_AT_LOGIN_PREFERENCE_FILE_NAME}.${id}.tmp`);
    let handle;
    try {
      handle = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
        LOGIN_ITEM_PREFERENCE_FILE_MODE,
      );
      await handle.chmod(LOGIN_ITEM_PREFERENCE_FILE_MODE);
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, target);
      const directory = await open(input.root, constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  };

  return {
    read() {
      return serialize(async () => {
        try {
          const record = await readRecord();
          return { state: "configured", enabled: record.enabled };
        } catch {
          return { state: "unavailable", enabled: false };
        }
      });
    },
    set(enabled) {
      return serialize(async () => {
        if (typeof enabled !== "boolean") return { status: "refused" };
        try {
          await writeRecord({ schemaVersion: 1, enabled });
          return { status: "stored", enabled };
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
  return stored.state === "configured" && stored.enabled;
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
