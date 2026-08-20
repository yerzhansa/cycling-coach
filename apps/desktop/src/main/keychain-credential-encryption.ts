import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { CredentialEncryptionPort } from "./credential-vault.js";
import {
  KEYCHAIN_KEY_BYTES,
  KEYCHAIN_TEAM_IDENTIFIER,
  type KeychainHelperErrorCode,
  type KeychainHelperTransport,
} from "./keychain-helper.js";

export const KEYCHAIN_PARTITION_STORAGE_BACKEND = "keychain_partition_v1" as const;
export const CREDENTIAL_ENVELOPE_MAGIC = "ENDURAGENT1" as const;
export const SAFE_STORAGE_ENVELOPE_KEY_ID = 0;
export const KEYCHAIN_ENVELOPE_KEY_ID = 1;
export const CREDENTIAL_ENVELOPE_IV_BYTES = 12;
export const CREDENTIAL_ENVELOPE_TAG_BYTES = 16;

const MAGIC = Buffer.from(CREDENTIAL_ENVELOPE_MAGIC, "ascii");
const HEADER_BYTES = MAGIC.length + 1;
const MINIMUM_ENVELOPE_BYTES =
  HEADER_BYTES + CREDENTIAL_ENVELOPE_IV_BYTES + CREDENTIAL_ENVELOPE_TAG_BYTES;

export class KeychainEncryptionError extends Error {
  constructor(readonly code: KeychainHelperErrorCode) {
    super();
  }
}

export class CredentialEnvelopeError extends Error {}

export function readCredentialEnvelopeKeyId(envelope: Buffer): number | undefined {
  if (envelope.length < MINIMUM_ENVELOPE_BYTES) return undefined;
  if (!envelope.subarray(0, MAGIC.length).equals(MAGIC)) return undefined;
  return envelope[MAGIC.length];
}

export function sealCredentialEnvelope(key: Buffer, value: string): Buffer {
  const iv = randomBytes(CREDENTIAL_ENVELOPE_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const header = Buffer.concat([MAGIC, Buffer.of(KEYCHAIN_ENVELOPE_KEY_ID)]);
  return Buffer.concat([header, iv, ciphertext, cipher.getAuthTag()]);
}

export function openCredentialEnvelope(key: Buffer, envelope: Buffer): string {
  if (readCredentialEnvelopeKeyId(envelope) !== KEYCHAIN_ENVELOPE_KEY_ID) {
    throw new CredentialEnvelopeError();
  }
  const iv = envelope.subarray(HEADER_BYTES, HEADER_BYTES + CREDENTIAL_ENVELOPE_IV_BYTES);
  const tag = envelope.subarray(envelope.length - CREDENTIAL_ENVELOPE_TAG_BYTES);
  const ciphertext = envelope.subarray(
    HEADER_BYTES + CREDENTIAL_ENVELOPE_IV_BYTES,
    envelope.length - CREDENTIAL_ENVELOPE_TAG_BYTES,
  );
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export type KeychainPartitionEncryptionResult =
  | {
      readonly status: "ready";
      readonly encryption: CredentialEncryptionPort;
      readonly createdKey: boolean;
    }
  | {
      readonly status: "unavailable";
      readonly code: KeychainHelperErrorCode;
      readonly encryption: CredentialEncryptionPort;
    }
  | {
      readonly status: "storage-failed";
      readonly code: KeychainHelperErrorCode;
      readonly encryption: CredentialEncryptionPort;
    }
  | {
      readonly status: "unsupported";
      readonly code: "not-team-signed";
    };

export interface CreateKeychainPartitionEncryptionOptions {
  readonly transport: KeychainHelperTransport;
  readonly service: string;
}

function refusingPort(code: KeychainHelperErrorCode, available: boolean): CredentialEncryptionPort {
  const refuse = (): never => {
    throw new KeychainEncryptionError(code);
  };
  return {
    isEncryptionAvailable: () => available,
    encryptString: refuse,
    decryptString: refuse,
    getSelectedStorageBackend: () => KEYCHAIN_PARTITION_STORAGE_BACKEND,
  };
}

function readyPort(key: Buffer): CredentialEncryptionPort {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => sealCredentialEnvelope(key, value),
    decryptString: (envelope: Buffer) => openCredentialEnvelope(key, envelope),
    getSelectedStorageBackend: () => KEYCHAIN_PARTITION_STORAGE_BACKEND,
  };
}

function refused(code: KeychainHelperErrorCode): KeychainPartitionEncryptionResult {
  if (code === "keychain-locked") {
    return { status: "unavailable", code, encryption: refusingPort(code, false) };
  }
  return { status: "storage-failed", code, encryption: refusingPort(code, true) };
}

export async function createKeychainPartitionEncryption(
  options: CreateKeychainPartitionEncryptionOptions,
): Promise<KeychainPartitionEncryptionResult> {
  const { transport, service } = options;
  const probe = await transport.send({ op: "probe", service });
  if (!probe.ok) {
    return probe.code === "not-team-signed"
      ? { status: "unsupported", code: "not-team-signed" }
      : refused(probe.code);
  }
  if (probe.op !== "probe" || probe.teamIdentifier !== KEYCHAIN_TEAM_IDENTIFIER) {
    return refused("unknown");
  }

  const create = async (): Promise<KeychainPartitionEncryptionResult> => {
    const created = await transport.send({ op: "create-key", service });
    if (!created.ok) return refused(created.code);
    if (created.op !== "create-key") return refused("unknown");
    const key = Buffer.from(created.key, "base64");
    if (key.length !== KEYCHAIN_KEY_BYTES) return refused("unknown");
    return { status: "ready", encryption: readyPort(key), createdKey: true };
  };

  const read = await transport.send({ op: "read-key", service });
  if (read.ok) {
    if (read.op !== "read-key") return refused("unknown");
    const key = Buffer.from(read.key, "base64");
    if (key.length !== KEYCHAIN_KEY_BYTES) return refused("unknown");
    return { status: "ready", encryption: readyPort(key), createdKey: false };
  }
  if (read.code === "item-not-found") return create();
  if (read.code !== "unreadable-item") return refused(read.code);

  const deleted = await transport.send({ op: "delete-key", service });
  if (!deleted.ok) return refused(deleted.code);
  if (deleted.op !== "delete-key") return refused("unknown");
  return create();
}
