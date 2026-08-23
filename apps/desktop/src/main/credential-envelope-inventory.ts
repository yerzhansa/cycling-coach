import { constants, type Stats } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { join } from "node:path";
import type { WindowsPrivateDirectoryBinding } from "@enduragent/core";
import { CREDENTIAL_FILE_MODE, DESKTOP_CREDENTIAL_SLOTS } from "./credential-vault.js";
import {
  CREDENTIAL_ENVELOPE_INSPECTION_BYTES,
  KEYCHAIN_ENVELOPE_KEY_ID,
  readCredentialEnvelopeKeyId,
} from "./keychain-credential-encryption.js";
import {
  TELEGRAM_CREDENTIAL_FILE_MODE,
  TELEGRAM_PROFILE_FILE_NAME,
} from "./telegram-credential-vault.js";
import { readWindowsPrivateFilePrefix } from "./windows-private-file.js";

export type CredentialEnvelopeVault = "credentials" | "telegram";

export const CREDENTIAL_ENVELOPE_DIRECTORY_ENTRY_LIMIT = 256;

export interface CredentialEnvelopeTarget {
  readonly vault: CredentialEnvelopeVault;
  readonly root: string;
  readonly fileName: string;
  readonly mode: number;
}

export interface CredentialEnvelopeRef extends CredentialEnvelopeTarget {
  readonly keyId: number | undefined;
}

export interface CredentialEnvelopeInventory {
  readonly deletionBlockers: readonly CredentialEnvelopeRef[];
  readonly keychainDependents: number;
  readonly unverified: number;
}

export interface CredentialEnvelopeRoots {
  readonly credentialRoot: string;
  readonly telegramRoot: string;
  readonly readEnvelopeFile?: (path: string) => Promise<Buffer>;
  readonly inspectEnvelopeTarget?: (
    target: CredentialEnvelopeTarget,
  ) => Promise<CredentialEnvelopeInspection>;
  readonly readEnvelopeDirectory?: (path: string) => Promise<string[]>;
}

export async function readCredentialEnvelopeDirectory(root: string): Promise<string[]> {
  const directory = await opendir(root);
  const entries: string[] = [];
  try {
    for await (const entry of directory) {
      if (entries.length >= CREDENTIAL_ENVELOPE_DIRECTORY_ENTRY_LIMIT) {
        throw new RangeError("credential envelope directory entry limit exceeded");
      }
      entries.push(entry.name);
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  return entries.sort();
}

export type CredentialEnvelopeInspection =
  | Readonly<{ status: "missing" }>
  | Readonly<{ status: "readable"; contents: Buffer }>
  | Readonly<{ status: "blocked" }>;

export interface InspectCredentialEnvelopeTargetOptions {
  readonly platform?: NodeJS.Platform;
  readonly windowsDirectory?: WindowsPrivateDirectoryBinding;
  readonly openFile?: typeof open;
}

export function credentialEnvelopeTargets(
  roots: CredentialEnvelopeRoots,
): readonly CredentialEnvelopeTarget[] {
  return [
    ...DESKTOP_CREDENTIAL_SLOTS.map((slot) => ({
      vault: "credentials" as const,
      root: roots.credentialRoot,
      fileName: `${slot}.bin`,
      mode: CREDENTIAL_FILE_MODE,
    })),
    {
      vault: "telegram" as const,
      root: roots.telegramRoot,
      fileName: TELEGRAM_PROFILE_FILE_NAME,
      mode: TELEGRAM_CREDENTIAL_FILE_MODE,
    },
  ];
}

export function credentialEnvelopeKeyId(envelope: Buffer): number | undefined {
  return readCredentialEnvelopeKeyId(envelope);
}

function transientCredentialEnvelopeTarget(
  roots: CredentialEnvelopeRoots,
  root: string,
  entry: string,
): CredentialEnvelopeTarget | undefined {
  if (root === roots.credentialRoot) {
    for (const slot of DESKTOP_CREDENTIAL_SLOTS) {
      for (const prefix of [`.${slot}.`, `.${slot}.bin.`]) {
        if (!entry.startsWith(prefix)) continue;
        for (const suffix of [".tmp", ".deleted"]) {
          if (!entry.endsWith(suffix)) continue;
          const id = entry.slice(prefix.length, -suffix.length);
          if (/^[A-Za-z0-9-]{1,128}$/.test(id)) {
            return {
              vault: "credentials",
              root,
              fileName: entry,
              mode: CREDENTIAL_FILE_MODE,
            };
          }
        }
      }
    }
    return undefined;
  }
  if (root !== roots.telegramRoot) return undefined;
  const prefix = `.${TELEGRAM_PROFILE_FILE_NAME}.`;
  if (!entry.startsWith(prefix)) return undefined;
  for (const suffix of [".tmp", ".deleted"]) {
    if (!entry.endsWith(suffix)) continue;
    const id = entry.slice(prefix.length, -suffix.length);
    if (/^[A-Za-z0-9-]{1,128}$/.test(id)) {
      return {
        vault: "telegram",
        root,
        fileName: entry,
        mode: TELEGRAM_CREDENTIAL_FILE_MODE,
      };
    }
  }
  return undefined;
}

async function inspectEnvelopeTarget(
  target: CredentialEnvelopeTarget,
  inspect: (target: CredentialEnvelopeTarget) => Promise<CredentialEnvelopeInspection>,
): Promise<CredentialEnvelopeRef | undefined> {
  let inspected: CredentialEnvelopeInspection;
  try {
    inspected = await inspect(target);
  } catch {
    return { ...target, keyId: undefined };
  }
  if (inspected.status === "missing") return undefined;
  if (inspected.status === "blocked") return { ...target, keyId: undefined };
  try {
    return { ...target, keyId: readCredentialEnvelopeKeyId(inspected.contents) };
  } finally {
    inspected.contents.fill(0);
  }
}

function permissions(mode: number): number {
  return mode & 0o777;
}

function safePosixEnvelopeMetadata(metadata: Stats, expectedMode: number): boolean {
  return (
    metadata.isFile() &&
    !metadata.isSymbolicLink() &&
    permissions(metadata.mode) === expectedMode &&
    (typeof process.getuid !== "function" || metadata.uid === process.getuid())
  );
}

function samePosixEnvelopeMetadata(first: Stats, second: Stats): boolean {
  return (
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.mode === second.mode &&
    first.uid === second.uid &&
    first.size === second.size &&
    first.mtimeMs === second.mtimeMs &&
    first.ctimeMs === second.ctimeMs &&
    first.isFile() === second.isFile() &&
    first.isSymbolicLink() === second.isSymbolicLink()
  );
}

async function inspectPosixCredentialEnvelopeTarget(
  target: CredentialEnvelopeTarget,
  openFile: typeof open = open,
): Promise<CredentialEnvelopeInspection> {
  const path = join(target.root, target.fileName);
  let beforeOpen: Stats;
  try {
    beforeOpen = await lstat(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { status: "missing" }
      : { status: "blocked" };
  }
  if (!safePosixEnvelopeMetadata(beforeOpen, target.mode)) return { status: "blocked" };
  const flags = constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await openFile(path, flags);
  } catch {
    return { status: "blocked" };
  }
  let contents: Buffer | undefined;
  try {
    const opened = await handle.stat();
    if (
      !safePosixEnvelopeMetadata(opened, target.mode) ||
      !samePosixEnvelopeMetadata(beforeOpen, opened) ||
      !Number.isSafeInteger(opened.size) ||
      opened.size < 0
    ) {
      return { status: "blocked" };
    }
    const prefixBytes = Math.min(opened.size, CREDENTIAL_ENVELOPE_INSPECTION_BYTES);
    contents = Buffer.allocUnsafe(prefixBytes);
    let offset = 0;
    while (offset < contents.length) {
      const read = await handle.read(contents, offset, contents.length - offset, offset);
      if (read.bytesRead <= 0) return { status: "blocked" };
      offset += read.bytesRead;
    }
    const afterRead = await handle.stat();
    let current: Stats;
    try {
      current = await lstat(path);
    } catch {
      return { status: "blocked" };
    }
    if (
      !safePosixEnvelopeMetadata(afterRead, target.mode) ||
      !safePosixEnvelopeMetadata(current, target.mode) ||
      !samePosixEnvelopeMetadata(beforeOpen, afterRead) ||
      !samePosixEnvelopeMetadata(afterRead, current)
    ) {
      return { status: "blocked" };
    }
    await handle.close();
    handle = undefined;
    return { status: "readable", contents };
  } catch {
    return { status: "blocked" };
  } finally {
    if (handle !== undefined) {
      contents?.fill(0);
      await handle.close().catch(() => undefined);
    }
  }
}

export async function inspectCredentialEnvelopeTarget(
  target: CredentialEnvelopeTarget,
  options: InspectCredentialEnvelopeTargetOptions = {},
): Promise<CredentialEnvelopeInspection> {
  if ((options.platform ?? process.platform) !== "win32") {
    return await inspectPosixCredentialEnvelopeTarget(target, options.openFile);
  }
  if (options.windowsDirectory === undefined) return { status: "blocked" };
  try {
    const snapshot = await readWindowsPrivateFilePrefix({
      directory: options.windowsDirectory,
      path: join(target.root, target.fileName),
      maximumReadBytes: CREDENTIAL_ENVELOPE_INSPECTION_BYTES,
      openFile: options.openFile,
    });
    return snapshot === undefined
      ? { status: "missing" }
      : { status: "readable", contents: snapshot.contents };
  } catch {
    return { status: "blocked" };
  }
}

function injectedEnvelopeInspector(
  read: (path: string) => Promise<Buffer>,
): (target: CredentialEnvelopeTarget) => Promise<CredentialEnvelopeInspection> {
  return async (target) => {
    try {
      return { status: "readable", contents: await read(join(target.root, target.fileName)) };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? { status: "missing" }
        : { status: "blocked" };
    }
  };
}

export async function scanCredentialEnvelopes(
  roots: CredentialEnvelopeRoots,
): Promise<CredentialEnvelopeInventory> {
  const inspect =
    roots.inspectEnvelopeTarget ??
    (roots.readEnvelopeFile === undefined
      ? inspectCredentialEnvelopeTarget
      : injectedEnvelopeInspector(roots.readEnvelopeFile));
  const readDirectory = roots.readEnvelopeDirectory ?? readCredentialEnvelopeDirectory;
  const deletionBlockers: CredentialEnvelopeRef[] = [];
  const canonicalEnvelopes: CredentialEnvelopeRef[] = [];
  const missingCanonicalTargets: CredentialEnvelopeTarget[] = [];
  for (const target of credentialEnvelopeTargets(roots)) {
    const inspected = await inspectEnvelopeTarget(target, inspect);
    if (inspected !== undefined) {
      deletionBlockers.push(inspected);
      canonicalEnvelopes.push(inspected);
    } else {
      missingCanonicalTargets.push(target);
    }
  }
  for (const root of new Set([roots.credentialRoot, roots.telegramRoot])) {
    let entries: string[];
    try {
      entries = await readDirectory(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (entries.length > CREDENTIAL_ENVELOPE_DIRECTORY_ENTRY_LIMIT) {
      throw new RangeError("credential envelope directory entry limit exceeded");
    }
    for (const entry of entries) {
      const target = transientCredentialEnvelopeTarget(roots, root, entry);
      if (target === undefined) continue;
      const inspected = await inspectEnvelopeTarget(target, inspect);
      if (inspected !== undefined) deletionBlockers.push(inspected);
    }
  }
  for (const target of missingCanonicalTargets) {
    const inspected = await inspectEnvelopeTarget(target, inspect);
    if (inspected !== undefined) {
      deletionBlockers.push(inspected);
      canonicalEnvelopes.push(inspected);
    }
  }
  const keychainDependents = deletionBlockers.filter(
    (blocker) => blocker.keyId === KEYCHAIN_ENVELOPE_KEY_ID,
  ).length;
  return {
    deletionBlockers,
    keychainDependents,
    unverified: canonicalEnvelopes.filter(
      (envelope) => envelope.keyId !== KEYCHAIN_ENVELOPE_KEY_ID,
    ).length,
  };
}
