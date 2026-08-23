import type { BigIntStats, Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  assertWindowsPrivateDirectoryStable,
  bindWindowsPrivateDirectory,
  type WindowsPrivateDirectoryBinding,
} from "@enduragent/core";
import {
  inspectCredentialEnvelopeTarget,
  readCredentialEnvelopeDirectory,
  scanCredentialEnvelopes,
  type CredentialEnvelopeInventory,
  type CredentialEnvelopeRoots,
  type CredentialEnvelopeVault,
} from "./credential-envelope-inventory.js";
import { CREDENTIAL_DIRECTORY_MODE } from "./credential-vault.js";
import { TELEGRAM_CREDENTIAL_DIRECTORY_MODE } from "./telegram-credential-vault.js";

interface CredentialRootIdentity {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
}

interface CredentialRootEntryIdentity {
  readonly name: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly uid: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly birthtimeNs: bigint;
}

interface CredentialRootContents {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly uid: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly entries: readonly CredentialRootEntryIdentity[];
}

export type CredentialEnvelopeRootBinding =
  | Readonly<{
      state: "missing";
      root: string;
      expectedMode: number;
    }>
  | Readonly<{
      state: "bound";
      root: string;
      expectedMode: number;
      identity: CredentialRootIdentity;
      contents: CredentialRootContents;
      windowsDirectory?: WindowsPrivateDirectoryBinding;
    }>;

export interface CredentialEnvelopeRootBindings {
  readonly platform: NodeJS.Platform;
  readonly credentials: CredentialEnvelopeRootBinding;
  readonly telegram: CredentialEnvelopeRootBinding;
}

export interface BoundCredentialEnvelopeScan {
  readonly bindings: CredentialEnvelopeRootBindings;
  readonly inventory: CredentialEnvelopeInventory;
}

function permissions(mode: number): number {
  return mode & 0o777;
}

export function isMissingCredentialRootError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function missingPath(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error("credential root is missing"), { code: "ENOENT", path });
}

function entryIdentity(name: string, metadata: BigIntStats): CredentialRootEntryIdentity {
  return Object.freeze({
    name,
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    uid: metadata.uid,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
    birthtimeNs: metadata.birthtimeNs,
  });
}

function sameEntry(
  first: CredentialRootEntryIdentity,
  second: CredentialRootEntryIdentity,
): boolean {
  return (
    first.name === second.name &&
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.mode === second.mode &&
    first.uid === second.uid &&
    first.size === second.size &&
    first.mtimeNs === second.mtimeNs &&
    first.ctimeNs === second.ctimeNs &&
    first.birthtimeNs === second.birthtimeNs
  );
}

function sameContents(first: CredentialRootContents, second: CredentialRootContents): boolean {
  return (
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.mode === second.mode &&
    first.uid === second.uid &&
    first.mtimeNs === second.mtimeNs &&
    first.ctimeNs === second.ctimeNs &&
    first.entries.length === second.entries.length &&
    first.entries.every((entry, index) => sameEntry(entry, second.entries[index]!))
  );
}

function sameRootMetadata(first: BigIntStats, second: BigIntStats): boolean {
  return (
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.mode === second.mode &&
    first.uid === second.uid &&
    first.mtimeNs === second.mtimeNs &&
    first.ctimeNs === second.ctimeNs
  );
}

async function readCredentialRootContents(root: string): Promise<CredentialRootContents> {
  const before = await lstat(root, { bigint: true });
  const names = await readCredentialEnvelopeDirectory(root);
  const entries: CredentialRootEntryIdentity[] = [];
  for (const name of names) {
    entries.push(entryIdentity(name, await lstat(join(root, name), { bigint: true })));
  }
  const after = await lstat(root, { bigint: true });
  if (!sameRootMetadata(before, after)) throw new TypeError("credential root changed");
  return Object.freeze({
    dev: after.dev,
    ino: after.ino,
    mode: after.mode,
    uid: after.uid,
    mtimeNs: after.mtimeNs,
    ctimeNs: after.ctimeNs,
    entries: Object.freeze(entries),
  });
}

export function assertPosixCredentialRoot(metadata: Stats, expectedMode: number): void {
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    permissions(metadata.mode) !== expectedMode ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid())
  ) {
    throw new TypeError("unsafe credential root");
  }
}

async function bindCredentialRoot(
  root: string,
  expectedMode: number,
  platform: NodeJS.Platform,
): Promise<CredentialEnvelopeRootBinding> {
  let metadata: Stats;
  try {
    metadata = await lstat(root);
  } catch (error) {
    if (isMissingCredentialRootError(error)) return { state: "missing", root, expectedMode };
    throw error;
  }
  if (platform === "win32") {
    const windowsDirectory = bindWindowsPrivateDirectory(dirname(root), root);
    const contents = await readCredentialRootContents(root);
    assertWindowsPrivateDirectoryStable(windowsDirectory);
    return {
      state: "bound",
      root,
      expectedMode,
      identity: windowsDirectory.identity,
      contents,
      windowsDirectory,
    };
  }
  assertPosixCredentialRoot(metadata, expectedMode);
  const contents = await readCredentialRootContents(root);
  const confirmedMetadata = await lstat(root);
  assertPosixCredentialRoot(confirmedMetadata, expectedMode);
  if (confirmedMetadata.dev !== metadata.dev || confirmedMetadata.ino !== metadata.ino) {
    throw new TypeError("credential root changed");
  }
  return {
    state: "bound",
    root,
    expectedMode,
    identity: { dev: metadata.dev, ino: metadata.ino },
    contents,
  };
}

export async function bindCredentialEnvelopeRoots(
  roots: CredentialEnvelopeRoots,
  platform: NodeJS.Platform = process.platform,
): Promise<CredentialEnvelopeRootBindings> {
  const credentials = await bindCredentialRoot(
    roots.credentialRoot,
    CREDENTIAL_DIRECTORY_MODE,
    platform,
  );
  const telegram = await bindCredentialRoot(
    roots.telegramRoot,
    TELEGRAM_CREDENTIAL_DIRECTORY_MODE,
    platform,
  );
  return { platform, credentials, telegram };
}

export function credentialRootBindingForVault(
  bindings: CredentialEnvelopeRootBindings,
  vault: CredentialEnvelopeVault,
): CredentialEnvelopeRootBinding {
  return bindings[vault];
}

export async function assertCredentialEnvelopeRootIdentityStable(
  binding: CredentialEnvelopeRootBinding,
  platform: NodeJS.Platform,
): Promise<void> {
  if (binding.state === "missing") {
    try {
      await lstat(binding.root);
    } catch (error) {
      if (isMissingCredentialRootError(error)) return;
      throw error;
    }
    throw new TypeError("missing credential root appeared");
  }
  if (platform === "win32") {
    assertWindowsPrivateDirectoryStable(binding.windowsDirectory!);
  } else {
    const metadata = await lstat(binding.root);
    assertPosixCredentialRoot(metadata, binding.expectedMode);
    if (metadata.dev !== binding.identity.dev || metadata.ino !== binding.identity.ino) {
      throw new TypeError("credential root changed");
    }
  }
}

export async function assertCredentialEnvelopeRootStable(
  binding: CredentialEnvelopeRootBinding,
  platform: NodeJS.Platform,
): Promise<void> {
  await assertCredentialEnvelopeRootIdentityStable(binding, platform);
  if (binding.state === "missing") return;
  const contents = await readCredentialRootContents(binding.root);
  if (!sameContents(binding.contents, contents)) {
    throw new TypeError("credential root changed");
  }
}

export async function refreshCredentialEnvelopeRootBindings(
  bindings: CredentialEnvelopeRootBindings,
): Promise<CredentialEnvelopeRootBindings> {
  const refresh = async (
    binding: CredentialEnvelopeRootBinding,
  ): Promise<CredentialEnvelopeRootBinding> => {
    await assertCredentialEnvelopeRootIdentityStable(binding, bindings.platform);
    if (binding.state === "missing") return binding;
    const contents = await readCredentialRootContents(binding.root);
    await assertCredentialEnvelopeRootIdentityStable(binding, bindings.platform);
    return { ...binding, contents };
  };
  return {
    platform: bindings.platform,
    credentials: await refresh(bindings.credentials),
    telegram: await refresh(bindings.telegram),
  };
}

export async function assertCredentialEnvelopeRootsStable(
  bindings: CredentialEnvelopeRootBindings,
): Promise<void> {
  await assertCredentialEnvelopeRootStable(bindings.credentials, bindings.platform);
  await assertCredentialEnvelopeRootStable(bindings.telegram, bindings.platform);
}

export async function useBoundCredentialRoot<T>(
  binding: CredentialEnvelopeRootBinding,
  platform: NodeJS.Platform,
  operation: () => Promise<T>,
): Promise<T> {
  if (binding.state === "missing") throw missingPath(binding.root);
  await assertCredentialEnvelopeRootStable(binding, platform);
  try {
    return await operation();
  } finally {
    await assertCredentialEnvelopeRootStable(binding, platform);
  }
}

export async function useBoundCredentialRootMutation<T>(
  binding: CredentialEnvelopeRootBinding,
  platform: NodeJS.Platform,
  operation: () => Promise<T>,
): Promise<T> {
  if (binding.state === "missing") throw missingPath(binding.root);
  await assertCredentialEnvelopeRootIdentityStable(binding, platform);
  try {
    return await operation();
  } finally {
    await assertCredentialEnvelopeRootIdentityStable(binding, platform);
  }
}

function bindingForRoot(
  bindings: CredentialEnvelopeRootBindings,
  root: string,
): CredentialEnvelopeRootBinding {
  if (bindings.credentials.root === root) return bindings.credentials;
  if (bindings.telegram.root === root) return bindings.telegram;
  throw new TypeError("unexpected credential root");
}

export function guardedCredentialEnvelopeRoots(
  roots: CredentialEnvelopeRoots,
  bindings: CredentialEnvelopeRootBindings,
): CredentialEnvelopeRoots {
  return {
    credentialRoot: roots.credentialRoot,
    telegramRoot: roots.telegramRoot,
    inspectEnvelopeTarget: async (target) => {
      const binding = bindingForRoot(bindings, target.root);
      if (binding.state === "missing") {
        await assertCredentialEnvelopeRootStable(binding, bindings.platform);
        return { status: "missing" as const };
      }
      return useBoundCredentialRoot(binding, bindings.platform, async () => {
        if (roots.inspectEnvelopeTarget !== undefined) {
          return await roots.inspectEnvelopeTarget(target);
        }
        if (roots.readEnvelopeFile !== undefined) {
          try {
            return {
              status: "readable" as const,
              contents: await roots.readEnvelopeFile(join(target.root, target.fileName)),
            };
          } catch (error) {
            return (error as NodeJS.ErrnoException).code === "ENOENT"
              ? { status: "missing" as const }
              : { status: "blocked" as const };
          }
        }
        return await inspectCredentialEnvelopeTarget(target, {
          platform: bindings.platform,
          windowsDirectory: binding.state === "bound" ? binding.windowsDirectory : undefined,
        });
      });
    },
    readEnvelopeDirectory: async (root) => {
      const binding = bindingForRoot(bindings, root);
      const readDirectory = roots.readEnvelopeDirectory ?? readCredentialEnvelopeDirectory;
      return useBoundCredentialRoot(binding, bindings.platform, () => readDirectory(root));
    },
  };
}

export async function scanBoundCredentialEnvelopes(
  roots: CredentialEnvelopeRoots,
  platform: NodeJS.Platform = process.platform,
): Promise<BoundCredentialEnvelopeScan> {
  const bindings = await bindCredentialEnvelopeRoots(roots, platform);
  const inventory = await scanCredentialEnvelopes(
    guardedCredentialEnvelopeRoots(roots, bindings),
  );
  await assertCredentialEnvelopeRootsStable(bindings);
  return { bindings, inventory };
}
