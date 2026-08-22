import type { Stats } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  assertWindowsPrivateDirectoryStable,
  bindWindowsPrivateDirectory,
  type WindowsPrivateDirectoryBinding,
} from "@enduragent/core";
import {
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
    return {
      state: "bound",
      root,
      expectedMode,
      identity: windowsDirectory.identity,
      windowsDirectory,
    };
  }
  assertPosixCredentialRoot(metadata, expectedMode);
  return {
    state: "bound",
    root,
    expectedMode,
    identity: { dev: metadata.dev, ino: metadata.ino },
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

export async function assertCredentialEnvelopeRootStable(
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
    return;
  }
  const metadata = await lstat(binding.root);
  assertPosixCredentialRoot(metadata, binding.expectedMode);
  if (metadata.dev !== binding.identity.dev || metadata.ino !== binding.identity.ino) {
    throw new TypeError("credential root changed");
  }
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
    readEnvelopeFile: async (path) => {
      const binding = bindingForRoot(bindings, dirname(path));
      const read = roots.readEnvelopeFile ?? ((target: string) => readFile(target));
      return useBoundCredentialRoot(binding, bindings.platform, () => read(path));
    },
    readEnvelopeDirectory: async (root) => {
      const binding = bindingForRoot(bindings, root);
      const readDirectory = roots.readEnvelopeDirectory ?? ((target: string) => readdir(target));
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
