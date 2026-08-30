import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  bindWindowsPrivateDirectory,
  classifyWindowsPrivatePathDurability,
  type WindowsPrivateDirectoryBinding,
} from "@enduragent/core";
import { durableAtomicReplace, syncDirectory } from "./durable-atomic-replace.js";
import {
  readWindowsPrivateFile,
  WindowsPrivateFileMaximumBytesExceededError,
} from "./windows-private-file.js";

export const DESKTOP_USAGE_PING_STATE_FILE_NAME = "desktop-usage-ping.json" as const;
export const DESKTOP_USAGE_PING_STATE_DIRECTORY_MODE = 0o700;
export const DESKTOP_USAGE_PING_STATE_FILE_MODE = 0o600;
export const DESKTOP_USAGE_PING_INTERVAL_MS = 24 * 60 * 60 * 1_000;

const MAX_DESKTOP_USAGE_PING_STATE_BYTES = 256;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

interface DesktopUsagePingStateRecord {
  readonly schemaVersion: 1;
  readonly instanceId: string;
  readonly lastAttemptAt: number;
}

type StoredDesktopUsagePingState =
  | Readonly<{ status: "missing" | "corrupt" }>
  | Readonly<{ status: "ready"; record: DesktopUsagePingStateRecord }>;

export type DesktopUsagePingClaim =
  | Readonly<{ status: "claimed"; instanceId: string }>
  | Readonly<{ status: "deferred"; retryAfterMs: number }>
  | Readonly<{ status: "unavailable" }>;

export interface DesktopUsagePingStateStore {
  claimAttempt(now: number): Promise<DesktopUsagePingClaim>;
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
    throw new TypeError("unsafe desktop usage ping path");
  }
}

function validInstanceId(value: unknown): value is string {
  return typeof value === "string" && UUID_V4_PATTERN.test(value);
}

function parseState(contents: string): DesktopUsagePingStateRecord | undefined {
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
    keys.length !== 3 ||
    keys[0] !== "instanceId" ||
    keys[1] !== "lastAttemptAt" ||
    keys[2] !== "schemaVersion" ||
    record.schemaVersion !== 1 ||
    !validInstanceId(record.instanceId) ||
    !Number.isSafeInteger(record.lastAttemptAt) ||
    (record.lastAttemptAt as number) < 0
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    instanceId: record.instanceId,
    lastAttemptAt: record.lastAttemptAt as number,
  };
}

export function createDesktopUsagePingStateStore(input: {
  readonly root: string;
  readonly platform?: NodeJS.Platform;
  readonly createInstanceId?: () => string;
  readonly openFile?: typeof open;
  readonly syncDirectory?: (root: string) => Promise<void>;
}): DesktopUsagePingStateStore {
  const platform = input.platform ?? process.platform;
  const createInstanceId = input.createInstanceId ?? randomUUID;
  const synchronizeDirectory = input.syncDirectory ?? syncDirectory;
  const target = join(input.root, DESKTOP_USAGE_PING_STATE_FILE_NAME);
  let pending: Promise<void> = Promise.resolve();

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = pending.then(operation);
    pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const synchronizeDirectoryIfSupported = async (root: string): Promise<void> => {
    if (
      platform === "win32" &&
      classifyWindowsPrivatePathDurability("directory-sync").kind === "unavailable"
    ) {
      return;
    }
    await synchronizeDirectory(root);
  };

  const prepareRoot = async (): Promise<WindowsPrivateDirectoryBinding | undefined> => {
    let created = false;
    let metadata: Stats;
    try {
      metadata = await lstat(input.root);
    } catch (error) {
      if (!isMissing(error)) throw error;
      await mkdir(input.root, {
        recursive: true,
        mode: DESKTOP_USAGE_PING_STATE_DIRECTORY_MODE,
      });
      created = true;
      metadata = await lstat(input.root);
    }
    if (!metadata.isDirectory()) throw new TypeError("invalid desktop usage ping root");
    const windowsDirectory =
      platform === "win32"
        ? bindWindowsPrivateDirectory(dirname(input.root), input.root)
        : undefined;
    if (platform !== "win32") {
      assertOwner(metadata, DESKTOP_USAGE_PING_STATE_DIRECTORY_MODE);
    }
    if (created) await synchronizeDirectoryIfSupported(dirname(input.root));
    const prefix = `.${DESKTOP_USAGE_PING_STATE_FILE_NAME}.`;
    let removed = false;
    for (const entry of await readdir(input.root)) {
      if (
        entry.startsWith(prefix) &&
        entry.endsWith(".tmp") &&
        /^[A-Za-z0-9-]{1,128}$/.test(entry.slice(prefix.length, -4))
      ) {
        await rm(join(input.root, entry), { force: true });
        removed = true;
      }
    }
    if (removed) await synchronizeDirectoryIfSupported(input.root);
    return windowsDirectory;
  };

  const readState = async (
    windowsDirectory: WindowsPrivateDirectoryBinding | undefined,
  ): Promise<StoredDesktopUsagePingState> => {
    if (platform === "win32") {
      let snapshot;
      try {
        snapshot = await readWindowsPrivateFile({
          directory: windowsDirectory!,
          path: target,
          maximumBytes: MAX_DESKTOP_USAGE_PING_STATE_BYTES,
          openFile: input.openFile,
        });
      } catch (error) {
        if (error instanceof WindowsPrivateFileMaximumBytesExceededError) {
          return { status: "corrupt" };
        }
        throw error;
      }
      if (snapshot === undefined) return { status: "missing" };
      const contents = snapshot.contents.toString("utf8");
      snapshot.contents.fill(0);
      const record = parseState(contents);
      return record === undefined ? { status: "corrupt" } : { status: "ready", record };
    }
    let before: Stats;
    try {
      before = await lstat(target);
    } catch (error) {
      if (isMissing(error)) return { status: "missing" };
      throw error;
    }
    if (!before.isFile()) throw new TypeError("invalid desktop usage ping state file");
    assertOwner(before, DESKTOP_USAGE_PING_STATE_FILE_MODE);
    if (before.size > MAX_DESKTOP_USAGE_PING_STATE_BYTES) return { status: "corrupt" };
    const handle = await (input.openFile ?? open)(
      target,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size > MAX_DESKTOP_USAGE_PING_STATE_BYTES
      ) {
        throw new TypeError("desktop usage ping state changed while opening");
      }
      assertOwner(opened, DESKTOP_USAGE_PING_STATE_FILE_MODE);
      const contents = await handle.readFile({ encoding: "utf8" });
      const afterRead = await handle.stat();
      if (
        Buffer.byteLength(contents, "utf8") > MAX_DESKTOP_USAGE_PING_STATE_BYTES ||
        afterRead.dev !== opened.dev ||
        afterRead.ino !== opened.ino ||
        afterRead.size !== opened.size ||
        afterRead.mtimeMs !== opened.mtimeMs ||
        afterRead.ctimeMs !== opened.ctimeMs
      ) {
        throw new TypeError("desktop usage ping state changed while reading");
      }
      const record = parseState(contents);
      return record === undefined ? { status: "corrupt" } : { status: "ready", record };
    } finally {
      await handle.close();
    }
  };

  const writeState = (record: DesktopUsagePingStateRecord) =>
    durableAtomicReplace({
      root: input.root,
      fileName: DESKTOP_USAGE_PING_STATE_FILE_NAME,
      contents: `${JSON.stringify(record)}\n`,
      mode: DESKTOP_USAGE_PING_STATE_FILE_MODE,
      platform,
      openFile: input.openFile,
      syncDirectory: synchronizeDirectory,
    });

  return {
    claimAttempt(now) {
      return serialize(async () => {
        if (!Number.isSafeInteger(now) || now < 0) return { status: "unavailable" };
        try {
          const windowsDirectory = await prepareRoot();
          const existing = await readState(windowsDirectory);
          if (existing.status === "ready") {
            const elapsed = now - existing.record.lastAttemptAt;
            if (elapsed < 0) {
              return { status: "deferred", retryAfterMs: DESKTOP_USAGE_PING_INTERVAL_MS };
            }
            if (elapsed < DESKTOP_USAGE_PING_INTERVAL_MS) {
              return {
                status: "deferred",
                retryAfterMs: DESKTOP_USAGE_PING_INTERVAL_MS - elapsed,
              };
            }
            const outcome = await writeState({ ...existing.record, lastAttemptAt: now });
            if (outcome.state !== "durably-committed") return { status: "unavailable" };
            return { status: "claimed", instanceId: existing.record.instanceId };
          }
          const instanceId = createInstanceId();
          if (!validInstanceId(instanceId)) return { status: "unavailable" };
          const outcome = await writeState({ schemaVersion: 1, instanceId, lastAttemptAt: now });
          if (outcome.state !== "durably-committed") return { status: "unavailable" };
          return { status: "claimed", instanceId };
        } catch {
          return { status: "unavailable" };
        }
      });
    },
  };
}
