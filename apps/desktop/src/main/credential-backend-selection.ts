import type {
  CredentialEnvelopeLockProof,
  SerializeCredentialEnvelopeMutation,
} from "./credential-envelope-lock.js";
import {
  createAutomaticKeyRetirementInspector,
  type KeychainKeyRetirement,
} from "./automatic-key-retirement.js";
import type { CredentialEncryptionPort } from "./credential-vault.js";
import type { CredentialEnvelopeRoots } from "./credential-envelope-inventory.js";
import {
  createKeychainPartitionEncryption,
  createRefusingKeychainEncryption,
  type KeychainKeyDeletion,
  type KeychainKeyPreparation,
} from "./keychain-credential-encryption.js";
import type { KeychainBindingErrorCode, KeychainBindingTransport } from "./keychain-binding.js";

export type DesktopCredentialBackendRefusal = "encryption-unavailable" | "storage-failed";

export type DesktopCredentialBackendSelection =
  | Readonly<{
      status: "keychain";
      encryption: CredentialEncryptionPort;
      unverifiedEnvelopes: number;
      createdKey: boolean;
      prepareKey: (proof: CredentialEnvelopeLockProof) => Promise<KeychainKeyPreparation>;
      validateKey: (proof: CredentialEnvelopeLockProof) => Promise<KeychainKeyPreparation>;
      retireKey: (proof: CredentialEnvelopeLockProof) => Promise<KeychainKeyRetirement>;
      deleteKeyForReset: (
        proof: CredentialEnvelopeLockProof,
      ) => Promise<KeychainKeyDeletion>;
    }>
  | Readonly<{ status: "safe-storage"; encryption: CredentialEncryptionPort }>
  | Readonly<{
      status: "refused";
      encryption: CredentialEncryptionPort;
      reason: DesktopCredentialBackendRefusal;
      code: KeychainBindingErrorCode;
      keyCleanupPending: boolean;
    }>;

export interface SelectDesktopCredentialBackendOptions extends CredentialEnvelopeRoots {
  readonly transport: KeychainBindingTransport;
  readonly service: string;
  readonly safeStorage: CredentialEncryptionPort;
  readonly platform?: NodeJS.Platform;
  readonly keyCleanupPending?: boolean;
  readonly serializeEnvelopeMutation: SerializeCredentialEnvelopeMutation;
}

export function keychainFailureRefusal(
  code: KeychainBindingErrorCode,
  hasDeletionBlockers: boolean,
): DesktopCredentialBackendRefusal {
  if (code === "keychain-locked" || code === "uninspectable-item" || code === "not-team-signed") {
    return "encryption-unavailable";
  }
  if (code === "unreadable-item") return "encryption-unavailable";
  if (code === "unknown") return "encryption-unavailable";
  if (hasDeletionBlockers && code === "item-not-found") {
    return "encryption-unavailable";
  }
  return "storage-failed";
}

export async function selectDesktopCredentialBackend(
  options: SelectDesktopCredentialBackendOptions,
): Promise<DesktopCredentialBackendSelection> {
  return await options.serializeEnvelopeMutation((proof) =>
    selectDesktopCredentialBackendLocked(options, proof),
  );
}

export async function selectDesktopCredentialBackendLocked(
  options: SelectDesktopCredentialBackendOptions,
  proof: CredentialEnvelopeLockProof,
): Promise<DesktopCredentialBackendSelection> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    return { status: "safe-storage", encryption: options.safeStorage };
  }
  return await selectMacCredentialBackend(options, proof);
}

async function selectMacCredentialBackend(
  options: SelectDesktopCredentialBackendOptions,
  proof: CredentialEnvelopeLockProof,
): Promise<DesktopCredentialBackendSelection> {
  let deletionBlockers = 0;
  let unverifiedEnvelopes = 0;
  const inspect = createAutomaticKeyRetirementInspector(
    options,
    options.platform ?? process.platform,
  );
  const keychain = await createKeychainPartitionEncryption({
    transport: options.transport,
    service: options.service,
    keyCleanupPending: options.keyCleanupPending,
    inspectAutomaticRetirement: async (currentProof) => {
      const inspection = await inspect(currentProof);
      if (inspection.status === "inspected") {
        deletionBlockers = inspection.deletionBlockers;
        unverifiedEnvelopes = inspection.unverified;
      }
      return inspection;
    },
    lockProof: proof,
  });
  if (keychain.status === "unsupported") {
    return {
      status: "refused",
      encryption: createRefusingKeychainEncryption(keychain.code, false),
      reason: "encryption-unavailable",
      code: keychain.code,
      keyCleanupPending: false,
    };
  }
  if (keychain.status !== "ready") {
    const reason = keychainFailureRefusal(keychain.code, deletionBlockers > 0);
    return {
      status: "refused",
      encryption: createRefusingKeychainEncryption(
        keychain.code,
        reason !== "encryption-unavailable",
      ),
      reason,
      code: keychain.code,
      keyCleanupPending: keychain.keyCleanupPending,
    };
  }
  return {
    status: "keychain",
    encryption: keychain.encryption,
    unverifiedEnvelopes,
    createdKey: keychain.createdKey,
    prepareKey: keychain.prepareKey,
    validateKey: keychain.validateKey,
    retireKey: keychain.retireKey,
    deleteKeyForReset: keychain.deleteKeyForReset,
  };
}
