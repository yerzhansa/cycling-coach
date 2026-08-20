import { constants } from "node:fs";
import { access } from "node:fs/promises";
import {
  selectDesktopCredentialBackend,
  type DesktopCredentialBackendSelection,
} from "./credential-backend-selection.js";
import type {
  CredentialEnvelopeLockProof,
  SerializeCredentialEnvelopeMutation,
} from "./credential-envelope-lock.js";
import type { CredentialEnvelopeRoots } from "./credential-envelope-inventory.js";
import type { CredentialEncryptionPort } from "./credential-vault.js";
import { createRefusingKeychainEncryption } from "./keychain-credential-encryption.js";
import {
  KEYCHAIN_CREDENTIAL_SERVICE,
  KEYCHAIN_CREDENTIAL_SERVICE_DEV,
  createKeychainHelperTransport,
  type KeychainHelperResponse,
  type KeychainHelperTransport,
} from "./keychain-helper.js";
import { resolveKeychainHelperPath, type KeychainHelperLocation } from "./keychain-helper-path.js";
import {
  retireKeychainKeyWhenLastEnvelopeGone,
  type KeychainKeyRetirement,
} from "./keychain-key-lifetime.js";

const UNAVAILABLE_HELPER_RESPONSE: KeychainHelperResponse = Object.freeze({
  ok: false,
  code: "not-team-signed",
});

export function desktopKeychainCredentialService(packaged: boolean): string {
  return packaged ? KEYCHAIN_CREDENTIAL_SERVICE : KEYCHAIN_CREDENTIAL_SERVICE_DEV;
}

export interface DesktopCredentialEncryption {
  readonly encryption: CredentialEncryptionPort;
  readonly selection: DesktopCredentialBackendSelection;
  readonly service: string;
  prepareEnvelopeWrite(proof: CredentialEnvelopeLockProof): Promise<void>;
  retireKeychainKey(proof: CredentialEnvelopeLockProof): Promise<KeychainKeyRetirement | undefined>;
}

export interface PrepareDesktopCredentialEncryptionOptions extends CredentialEnvelopeRoots {
  readonly location: KeychainHelperLocation;
  readonly safeStorage: CredentialEncryptionPort;
  readonly createTransport?: (helperPath: string) => KeychainHelperTransport;
  readonly helperIsExecutable?: (helperPath: string) => Promise<boolean>;
  readonly serializeEnvelopeMutation: SerializeCredentialEnvelopeMutation;
}

async function helperIsExecutableFile(helperPath: string): Promise<boolean> {
  try {
    await access(helperPath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function prepareDesktopCredentialEncryption(
  options: PrepareDesktopCredentialEncryptionOptions,
): Promise<DesktopCredentialEncryption> {
  const service = desktopKeychainCredentialService(options.location.packaged);
  const helperPath = resolveKeychainHelperPath(options.location);
  const roots = {
    credentialRoot: options.credentialRoot,
    telegramRoot: options.telegramRoot,
    readEnvelopeFile: options.readEnvelopeFile,
  };
  let transport: KeychainHelperTransport = { send: async () => UNAVAILABLE_HELPER_RESPONSE };
  let selection: DesktopCredentialBackendSelection;
  try {
    const usableHelper =
      helperPath !== undefined &&
      (await (options.helperIsExecutable ?? helperIsExecutableFile)(helperPath));
    if (usableHelper && helperPath !== undefined) {
      transport = (
        options.createTransport ??
        ((path: string) => createKeychainHelperTransport({ helperPath: path }))
      )(helperPath);
    }
    selection = await selectDesktopCredentialBackend({
      ...roots,
      transport,
      service,
      safeStorage: options.safeStorage,
      platform: options.location.platform,
      serializeEnvelopeMutation: options.serializeEnvelopeMutation,
    });
  } catch {
    selection = {
      status: "refused",
      encryption: createRefusingKeychainEncryption("unknown", true),
      reason: "storage-failed",
      code: "unknown",
    };
  }
  return {
    encryption: selection.encryption,
    selection,
    service,
    async prepareEnvelopeWrite(proof: CredentialEnvelopeLockProof): Promise<void> {
      if (selection.status !== "keychain") return;
      await selection.prepareKey(proof);
    },
    async retireKeychainKey(
      proof: CredentialEnvelopeLockProof,
    ): Promise<KeychainKeyRetirement | undefined> {
      if (selection.status !== "keychain") return undefined;
      return await retireKeychainKeyWhenLastEnvelopeGone({
        ...roots,
        lockProof: proof,
        deleteKey: selection.deleteKey,
      });
    },
  };
}
