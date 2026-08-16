import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  bindWindowsPrivateDirectory,
  classifyWindowsPrivatePathDurability,
  type WindowsPrivateDirectoryBinding,
} from "@enduragent/core";
import { compareDesktopVersions, isStableDesktopVersion } from "./desktop-version.js";
import { durableAtomicReplace, syncDirectory } from "./durable-atomic-replace.js";
import { createSafeLog } from "./safe-log.js";
import {
  readWindowsPrivateFile,
  WindowsPrivateFileMaximumBytesExceededError,
} from "./windows-private-file.js";

export const DESKTOP_UPDATE_VERSION_FLOOR_FILE_NAME = "highest-desktop-version.json" as const;
export const DESKTOP_UPDATE_VERSION_FLOOR_DIRECTORY_MODE = 0o700;
export const DESKTOP_UPDATE_VERSION_FLOOR_FILE_MODE = 0o600;

const MAX_VERSION_FLOOR_FILE_BYTES = 256;

type StoredVersionFloor =
  | Readonly<{ status: "missing" }>
  | Readonly<{ status: "corrupt" }>
  | Readonly<{ status: "ready"; version: string }>;

export type DesktopUpdateVersionFloorResult =
  | Readonly<{ status: "ready"; version: string }>
  | Readonly<{ status: "unavailable" }>;

export interface DesktopUpdateVersionFloor {
  recordRunningVersion(version: string): Promise<DesktopUpdateVersionFloorResult>;
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
    throw new TypeError("unsafe update version floor path");
  }
}

function parseVersionFloor(contents: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (
    !Number.isSafeInteger(record.schemaVersion) ||
    (record.schemaVersion as number) < 1 ||
    !isStableDesktopVersion(record.version)
  ) {
    return undefined;
  }
  return record.version;
}

export function createDesktopUpdateVersionFloor(input: {
  readonly root: string;
  readonly log?: (message: string) => void;
  readonly platform?: NodeJS.Platform;
  readonly openFile?: typeof open;
  readonly syncDirectory?: (root: string) => Promise<void>;
}): DesktopUpdateVersionFloor {
  const platform = input.platform ?? process.platform;
  const synchronizeDirectory = input.syncDirectory ?? syncDirectory;
  const target = join(input.root, DESKTOP_UPDATE_VERSION_FLOOR_FILE_NAME);
  const log = createSafeLog(input.log);
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
        mode: DESKTOP_UPDATE_VERSION_FLOOR_DIRECTORY_MODE,
      });
      created = true;
      metadata = await lstat(input.root);
    }
    if (!metadata.isDirectory()) throw new TypeError("invalid update version floor root");
    const windowsDirectory =
      platform === "win32"
        ? bindWindowsPrivateDirectory(dirname(input.root), input.root)
        : undefined;
    if (platform !== "win32") {
      assertOwner(metadata, DESKTOP_UPDATE_VERSION_FLOOR_DIRECTORY_MODE);
    }
    if (created) await synchronizeDirectoryIfSupported(dirname(input.root));
    const prefix = `.${DESKTOP_UPDATE_VERSION_FLOOR_FILE_NAME}.`;
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

  const readFloor = async (
    windowsDirectory: WindowsPrivateDirectoryBinding | undefined,
  ): Promise<StoredVersionFloor> => {
    if (platform === "win32") {
      let snapshot;
      try {
        snapshot = await readWindowsPrivateFile({
          directory: windowsDirectory!,
          path: target,
          maximumBytes: MAX_VERSION_FLOOR_FILE_BYTES,
          openFile: input.openFile,
        });
      } catch (error) {
        if (error instanceof WindowsPrivateFileMaximumBytesExceededError) {
          return { status: "corrupt" };
        }
        throw error;
      }
      if (snapshot === undefined) return { status: "missing" };
      const version = parseVersionFloor(snapshot.contents.toString("utf8"));
      return version === undefined
        ? { status: "corrupt" }
        : { status: "ready", version };
    }
    let before: Stats;
    try {
      before = await lstat(target);
    } catch (error) {
      if (isMissing(error)) return { status: "missing" };
      throw error;
    }
    if (!before.isFile()) throw new TypeError("invalid update version floor file");
    assertOwner(before, DESKTOP_UPDATE_VERSION_FLOOR_FILE_MODE);
    if (before.size > MAX_VERSION_FLOOR_FILE_BYTES) return { status: "corrupt" };
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
        opened.size > MAX_VERSION_FLOOR_FILE_BYTES
      ) {
        throw new TypeError("update version floor changed while opening");
      }
      assertOwner(opened, DESKTOP_UPDATE_VERSION_FLOOR_FILE_MODE);
      const contents = await handle.readFile({ encoding: "utf8" });
      const version = parseVersionFloor(contents);
      return version === undefined
        ? { status: "corrupt" }
        : { status: "ready", version };
    } finally {
      await handle.close();
    }
  };

  const writeFloor = (version: string) =>
    durableAtomicReplace({
      root: input.root,
      fileName: DESKTOP_UPDATE_VERSION_FLOOR_FILE_NAME,
      contents: `${JSON.stringify({ schemaVersion: 1, version })}\n`,
      mode: DESKTOP_UPDATE_VERSION_FLOOR_FILE_MODE,
      platform,
      openFile: input.openFile,
      syncDirectory: synchronizeDirectory,
    });

  return {
    recordRunningVersion(version) {
      return serialize(async () => {
        if (!isStableDesktopVersion(version)) return { status: "unavailable" };
        try {
          const windowsDirectory = await prepareRoot();
          const existing = await readFloor(windowsDirectory);
          if (existing.status === "ready") {
            const comparison = compareDesktopVersions(existing.version, version);
            if (comparison === null) return { status: "unavailable" };
            if (comparison >= 0) return { status: "ready", version: existing.version };
          }
          const outcome = await writeFloor(version);
          if (outcome.state !== "durably-committed") return { status: "unavailable" };
          if (existing.status === "corrupt") log("desktop-update-version-floor-recovered");
          return { status: "ready", version };
        } catch {
          return { status: "unavailable" };
        }
      });
    },
  };
}
