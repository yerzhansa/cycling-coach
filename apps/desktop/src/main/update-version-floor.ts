import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { compareDesktopVersions, isStableDesktopVersion } from "./desktop-version.js";
import { durableAtomicReplace } from "./durable-atomic-replace.js";

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

async function synchronizeDirectory(root: string): Promise<void> {
  const directory = await open(root, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close().catch(() => undefined);
  }
}

export function createDesktopUpdateVersionFloor(input: {
  readonly root: string;
  readonly createId?: () => string;
  readonly log?: (message: string) => void;
}): DesktopUpdateVersionFloor {
  const target = join(input.root, DESKTOP_UPDATE_VERSION_FLOOR_FILE_NAME);
  const createId = input.createId ?? randomUUID;
  const outputLog =
    input.log ??
    ((message: string): void => {
      process.stderr.write(`${message}\n`);
    });
  let pending: Promise<void> = Promise.resolve();

  const log = (message: string): void => {
    try {
      outputLog(message);
    } catch {}
  };

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = pending.then(operation);
    pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const prepareRoot = async (): Promise<void> => {
    let created = false;
    try {
      await lstat(input.root);
    } catch (error) {
      if (!isMissing(error)) throw error;
      await mkdir(input.root, {
        recursive: true,
        mode: DESKTOP_UPDATE_VERSION_FLOOR_DIRECTORY_MODE,
      });
      created = true;
    }
    const metadata = await lstat(input.root);
    if (!metadata.isDirectory()) throw new TypeError("invalid update version floor root");
    assertOwner(metadata, DESKTOP_UPDATE_VERSION_FLOOR_DIRECTORY_MODE);
    if (created) await synchronizeDirectory(dirname(input.root));
    const prefix = `.${DESKTOP_UPDATE_VERSION_FLOOR_FILE_NAME}.`;
    for (const entry of await readdir(input.root)) {
      if (
        entry.startsWith(prefix) &&
        entry.endsWith(".tmp") &&
        /^[A-Za-z0-9-]{1,128}$/.test(entry.slice(prefix.length, -4))
      ) {
        await rm(join(input.root, entry), { force: true });
      }
    }
    await synchronizeDirectory(input.root);
  };

  const readFloor = async (): Promise<StoredVersionFloor> => {
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
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
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
      createId,
    });

  return {
    recordRunningVersion(version) {
      return serialize(async () => {
        if (!isStableDesktopVersion(version)) return { status: "unavailable" };
        try {
          await prepareRoot();
          const existing = await readFloor();
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
