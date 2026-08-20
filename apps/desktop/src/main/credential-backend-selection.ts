import type { rename, rm } from "node:fs/promises";
import type { CredentialEncryptionPort } from "./credential-vault.js";
import {
  scanCredentialEnvelopes,
  type CredentialEnvelopeRoots,
} from "./credential-envelope-inventory.js";
import {
  createKeychainPartitionEncryption,
  createRefusingKeychainEncryption,
} from "./keychain-credential-encryption.js";
import type { KeychainHelperErrorCode, KeychainHelperTransport } from "./keychain-helper.js";
import {
  createLegacyReadFallbackEncryption,
  migrateCredentialEnvelopes,
  type CredentialMigrationOutcome,
} from "./credential-key-migration.js";

export type DesktopCredentialBackendRefusal = "encryption-unavailable" | "storage-failed";

export type DesktopCredentialBackendSelection =
  | Readonly<{
      status: "keychain";
      encryption: CredentialEncryptionPort;
      migration: CredentialMigrationOutcome;
      createdKey: boolean;
    }>
  | Readonly<{ status: "safe-storage"; encryption: CredentialEncryptionPort }>
  | Readonly<{
      status: "refused";
      encryption: CredentialEncryptionPort;
      reason: DesktopCredentialBackendRefusal;
      code: KeychainHelperErrorCode;
    }>;

export interface SelectDesktopCredentialBackendOptions extends CredentialEnvelopeRoots {
  readonly transport: KeychainHelperTransport;
  readonly service: string;
  readonly safeStorage: CredentialEncryptionPort;
  readonly platform?: NodeJS.Platform;
  readonly createId?: () => string;
  readonly renameFile?: typeof rename;
  readonly removeFile?: typeof rm;
  readonly syncDirectory?: (root: string) => Promise<void>;
}

export function keychainFailureRefusal(
  code: KeychainHelperErrorCode,
): DesktopCredentialBackendRefusal {
  return code === "keychain-locked" || code === "not-team-signed"
    ? "encryption-unavailable"
    : "storage-failed";
}

export async function selectDesktopCredentialBackend(
  options: SelectDesktopCredentialBackendOptions,
): Promise<DesktopCredentialBackendSelection> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    return { status: "safe-storage", encryption: options.safeStorage };
  }
  const inventory = await scanCredentialEnvelopes(options);
  const keychain = await createKeychainPartitionEncryption({
    transport: options.transport,
    service: options.service,
  });
  if (keychain.status === "unsupported") {
    if (!inventory.keychainRequired) {
      return { status: "safe-storage", encryption: options.safeStorage };
    }
    return {
      status: "refused",
      encryption: createRefusingKeychainEncryption(keychain.code, false),
      reason: keychainFailureRefusal(keychain.code),
      code: keychain.code,
    };
  }
  if (keychain.status !== "ready") {
    return {
      status: "refused",
      encryption: keychain.encryption,
      reason: keychainFailureRefusal(keychain.code),
      code: keychain.code,
    };
  }
  const migration =
    inventory.legacy.length === 0 && inventory.unreadable === 0
      ? ({
          status: "complete",
          migrated: 0,
          alreadyMigrated: inventory.migrated,
          failed: 0,
          uncertain: 0,
        } as const)
      : await migrateCredentialEnvelopes({
          ...options,
          platform,
          legacy: options.safeStorage,
          keychain: keychain.encryption,
        });
  return {
    status: "keychain",
    encryption:
      migration.status === "complete"
        ? keychain.encryption
        : createLegacyReadFallbackEncryption({
            keychain: keychain.encryption,
            legacy: options.safeStorage,
          }),
    migration,
    createdKey: keychain.createdKey,
  };
}
