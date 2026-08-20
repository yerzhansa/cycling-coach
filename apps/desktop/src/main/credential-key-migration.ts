import type { rename, rm } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CredentialEncryptionPort } from "./credential-vault.js";
import {
  credentialEnvelopeKeyId,
  scanCredentialEnvelopes,
  type CredentialEnvelopeRef,
  type CredentialEnvelopeRoots,
} from "./credential-envelope-inventory.js";
import { durablyReplaceReversible } from "./durable-atomic-replace.js";
import {
  KEYCHAIN_ENVELOPE_KEY_ID,
  KEYCHAIN_PARTITION_STORAGE_BACKEND,
  SAFE_STORAGE_ENVELOPE_KEY_ID,
  readCredentialEnvelopeKeyId,
} from "./keychain-credential-encryption.js";

export type CredentialEnvelopeMigrationState =
  | "migrated"
  | "already-migrated"
  | "absent"
  | "failed"
  | "uncertain";

export interface CredentialMigrationOutcome {
  readonly status: "complete" | "incomplete";
  readonly migrated: number;
  readonly alreadyMigrated: number;
  readonly failed: number;
  readonly uncertain: number;
}

export interface MigrateCredentialEnvelopesOptions extends CredentialEnvelopeRoots {
  readonly legacy: CredentialEncryptionPort;
  readonly keychain: CredentialEncryptionPort;
  readonly platform?: NodeJS.Platform;
  readonly createId?: () => string;
  readonly renameFile?: typeof rename;
  readonly removeFile?: typeof rm;
  readonly syncDirectory?: (root: string) => Promise<void>;
}

export function createLegacyReadFallbackEncryption(options: {
  readonly keychain: CredentialEncryptionPort;
  readonly legacy: CredentialEncryptionPort;
}): CredentialEncryptionPort {
  return {
    isEncryptionAvailable: () => options.keychain.isEncryptionAvailable(),
    encryptString: (value: string) => options.keychain.encryptString(value),
    decryptString: (envelope: Buffer) =>
      readCredentialEnvelopeKeyId(envelope) === KEYCHAIN_ENVELOPE_KEY_ID
        ? options.keychain.decryptString(envelope)
        : options.legacy.decryptString(envelope),
    getSelectedStorageBackend: () => KEYCHAIN_PARTITION_STORAGE_BACKEND,
  };
}

async function migrateEnvelope(
  envelope: CredentialEnvelopeRef,
  options: MigrateCredentialEnvelopesOptions,
): Promise<CredentialEnvelopeMigrationState> {
  const read = options.readEnvelopeFile ?? readFile;
  const path = join(envelope.root, envelope.fileName);
  let previous: Buffer | undefined;
  let sealed: Buffer | undefined;
  try {
    try {
      previous = await read(path);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "failed";
    }
    const keyId = credentialEnvelopeKeyId(previous);
    if (keyId === KEYCHAIN_ENVELOPE_KEY_ID) return "already-migrated";
    if (keyId !== SAFE_STORAGE_ENVELOPE_KEY_ID) return "failed";
    let value: string;
    try {
      value = options.legacy.decryptString(previous);
    } catch {
      return "failed";
    }
    if (value.length === 0) return "failed";
    try {
      sealed = options.keychain.encryptString(value);
      if (!Buffer.isBuffer(sealed) || sealed.length === 0) return "failed";
      if (readCredentialEnvelopeKeyId(sealed) !== KEYCHAIN_ENVELOPE_KEY_ID) return "failed";
      if (options.keychain.decryptString(sealed) !== value) return "failed";
    } catch {
      return "failed";
    }
    const replacement = {
      root: envelope.root,
      fileName: envelope.fileName,
      mode: envelope.mode,
      platform: options.platform,
      createId: options.createId,
      renameFile: options.renameFile,
      removeFile: options.removeFile,
      syncDirectory: options.syncDirectory,
    };
    const stored = await durablyReplaceReversible({
      ...replacement,
      contents: sealed,
      previousContents: previous,
    });
    if (stored.state === "refused") return "failed";
    if (stored.state === "uncertain") return "uncertain";
    let written: Buffer | undefined;
    try {
      written = await read(path);
      if (options.keychain.decryptString(written) !== value) throw new TypeError();
      return "migrated";
    } catch {
      const restored = await durablyReplaceReversible({
        ...replacement,
        contents: previous,
        previousContents: sealed,
      });
      return restored.state === "applied" ? "failed" : "uncertain";
    } finally {
      written?.fill(0);
    }
  } finally {
    previous?.fill(0);
    sealed?.fill(0);
  }
}

export async function migrateCredentialEnvelopes(
  options: MigrateCredentialEnvelopesOptions,
): Promise<CredentialMigrationOutcome> {
  const inventory = await scanCredentialEnvelopes(options);
  let migrated = 0;
  let alreadyMigrated = 0;
  let failed = 0;
  let uncertain = 0;
  for (const envelope of inventory.envelopes) {
    if (envelope.keyId === KEYCHAIN_ENVELOPE_KEY_ID) {
      alreadyMigrated += 1;
      continue;
    }
    const state = await migrateEnvelope(envelope, options);
    if (state === "migrated") migrated += 1;
    else if (state === "already-migrated") alreadyMigrated += 1;
    else if (state === "failed") failed += 1;
    else if (state === "uncertain") uncertain += 1;
  }
  return {
    status: failed === 0 && uncertain === 0 ? "complete" : "incomplete",
    migrated,
    alreadyMigrated,
    failed,
    uncertain,
  };
}
