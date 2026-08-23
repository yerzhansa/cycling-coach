import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import {
  isZeroDeletionBlockerCensusProof,
  type InspectAutomaticKeyRetirement,
  type KeychainKeyRetirement,
  type ZeroDeletionBlockerCensusProof,
} from "./automatic-key-retirement.js";
import type { CredentialEnvelopeLockProof } from "./credential-envelope-lock.js";
import type { CredentialEncryptionPort } from "./credential-vault.js";
import type { KeyCleanupDebt } from "./key-cleanup-debt.js";
import {
  CREDENTIAL_ENVELOPE_HEADER_BYTES,
  CREDENTIAL_ENVELOPE_IV_BYTES,
  CREDENTIAL_ENVELOPE_MAGIC,
  CREDENTIAL_ENVELOPE_TAG_BYTES,
  KEYCHAIN_ENVELOPE_KEY_ID,
  readCredentialEnvelopeKeyId,
} from "./credential-envelope-format.js";
import {
  KEYCHAIN_KEY_BYTES,
  KEYCHAIN_TEAM_IDENTIFIER,
  type KeychainBindingErrorCode,
  type KeychainBindingResponse,
  type KeychainBindingTransport,
} from "./keychain-binding.js";

export const KEYCHAIN_PARTITION_STORAGE_BACKEND = "keychain_partition_v1" as const;
export {
  CREDENTIAL_ENVELOPE_HEADER_BYTES,
  CREDENTIAL_ENVELOPE_INSPECTION_BYTES,
  CREDENTIAL_ENVELOPE_IV_BYTES,
  CREDENTIAL_ENVELOPE_MAGIC,
  CREDENTIAL_ENVELOPE_TAG_BYTES,
  KEYCHAIN_ENVELOPE_KEY_ID,
  SAFE_STORAGE_ENVELOPE_KEY_ID,
  readCredentialEnvelopeKeyId,
} from "./credential-envelope-format.js";

const MAGIC = Buffer.from(CREDENTIAL_ENVELOPE_MAGIC, "ascii");

export class KeychainEncryptionError extends Error {
  constructor(readonly code: KeychainBindingErrorCode) {
    super();
  }
}

export class CredentialEnvelopeError extends Error {}

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
  const iv = envelope.subarray(
    CREDENTIAL_ENVELOPE_HEADER_BYTES,
    CREDENTIAL_ENVELOPE_HEADER_BYTES + CREDENTIAL_ENVELOPE_IV_BYTES,
  );
  const tag = envelope.subarray(envelope.length - CREDENTIAL_ENVELOPE_TAG_BYTES);
  const ciphertext = envelope.subarray(
    CREDENTIAL_ENVELOPE_HEADER_BYTES + CREDENTIAL_ENVELOPE_IV_BYTES,
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
      readonly prepareKey: (proof: CredentialEnvelopeLockProof) => Promise<KeychainKeyPreparation>;
      readonly validateKey: (proof: CredentialEnvelopeLockProof) => Promise<KeychainKeyPreparation>;
      readonly retireKey: (proof: CredentialEnvelopeLockProof) => Promise<KeychainKeyRetirement>;
      readonly deleteKeyForReset: (
        proof: CredentialEnvelopeLockProof,
      ) => Promise<KeychainKeyDeletion>;
    }
  | {
      readonly status: "unavailable";
      readonly code: KeychainBindingErrorCode;
      readonly keyCleanupDebt: KeyCleanupDebt;
      readonly encryption: CredentialEncryptionPort;
    }
  | {
      readonly status: "storage-failed";
      readonly code: KeychainBindingErrorCode;
      readonly keyCleanupDebt: KeyCleanupDebt;
      readonly encryption: CredentialEncryptionPort;
    }
  | {
      readonly status: "unsupported";
      readonly code: "not-team-signed";
      readonly keyCleanupDebt: KeyCleanupDebt;
    };

export interface CreateKeychainPartitionEncryptionOptions {
  readonly transport: KeychainBindingTransport;
  readonly service: string;
  readonly inspectAutomaticRetirement: InspectAutomaticKeyRetirement;
  readonly keyCleanupDebt?: KeyCleanupDebt;
  readonly lockProof: CredentialEnvelopeLockProof;
}

export function createRefusingKeychainEncryption(
  code: KeychainBindingErrorCode,
  available: boolean,
): CredentialEncryptionPort {
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

export type KeychainKeyPreparation =
  | Readonly<{ status: "ready" }>
  | Readonly<{
      status: "failed";
      code: KeychainBindingErrorCode;
      keyCleanupDebt: Exclude<KeyCleanupDebt, "none">;
    }>
  | Readonly<{
      status: "failed";
      code: KeychainBindingErrorCode;
      keyCleanupDebt?: "none";
    }>;

export type KeychainKeyDeletion =
  | Readonly<{ status: "deleted" | "already-absent" }>
  | Readonly<{ status: "failed"; code: KeychainBindingErrorCode }>;

interface KeyHolder {
  key: Buffer | null;
  failure: KeychainBindingErrorCode;
  cleanupDebt: KeyCleanupDebt;
}

function readyPort(holder: KeyHolder): CredentialEncryptionPort {
  const currentKey = (): Buffer => {
    if (holder.key === null) throw new KeychainEncryptionError(holder.failure);
    return holder.key;
  };
  return {
    isEncryptionAvailable: () => holder.key !== null,
    encryptString: (value: string) => sealCredentialEnvelope(currentKey(), value),
    decryptString: (envelope: Buffer) => openCredentialEnvelope(currentKey(), envelope),
    getSelectedStorageBackend: () => KEYCHAIN_PARTITION_STORAGE_BACKEND,
  };
}

function refused(
  code: KeychainBindingErrorCode,
  keyCleanupDebt: KeyCleanupDebt = "none",
): KeychainPartitionEncryptionResult {
  if (code === "keychain-locked" || code === "uninspectable-item" || code === "item-not-found") {
    return {
      status: "unavailable",
      code,
      keyCleanupDebt,
      encryption: createRefusingKeychainEncryption(code, false),
    };
  }
  return {
    status: "storage-failed",
    code,
    keyCleanupDebt,
    encryption: createRefusingKeychainEncryption(code, true),
  };
}

export async function createKeychainPartitionEncryption(
  options: CreateKeychainPartitionEncryptionOptions,
): Promise<KeychainPartitionEncryptionResult> {
  const { transport, service } = options;
  const retryCreationRollback = async (): Promise<
    | Readonly<{ status: "ready" }>
    | Readonly<{ status: "failed"; code: KeychainBindingErrorCode }>
  > => {
    try {
      const retried = await transport.send({ op: "retry-created-key-rollback", service });
      if (!retried.ok) return { status: "failed", code: retried.code };
      return retried.op === "retry-created-key-rollback"
        ? { status: "ready" }
        : { status: "failed", code: "unknown" };
    } catch {
      return { status: "failed", code: "unknown" };
    }
  };
  let initialCleanupDebt = options.keyCleanupDebt ?? "none";
  const probe = await transport.send({ op: "probe", service });
  if (!probe.ok) {
    return probe.code === "not-team-signed"
      ? { status: "unsupported", code: "not-team-signed", keyCleanupDebt: initialCleanupDebt }
      : refused(probe.code, initialCleanupDebt);
  }
  if (probe.op !== "probe" || probe.teamIdentifier !== KEYCHAIN_TEAM_IDENTIFIER) {
    return refused("unknown", initialCleanupDebt);
  }
  const retried = await retryCreationRollback();
  if (retried.status === "failed") return refused(retried.code, "creation-rollback");
  if (initialCleanupDebt === "creation-rollback") initialCleanupDebt = "none";
  const inspectAutomaticRetirement = async (proof: CredentialEnvelopeLockProof) => {
    if (proof !== options.lockProof) return { status: "failed" as const };
    try {
      return await options.inspectAutomaticRetirement(proof);
    } catch {
      return { status: "failed" as const };
    }
  };
  const initialInspection = await inspectAutomaticRetirement(options.lockProof);
  if (initialInspection.status === "failed") {
    return refused("unknown", initialCleanupDebt);
  }

  const createMaterial = async (): Promise<
    | Readonly<{ status: "ready"; key: Buffer }>
    | Readonly<{
        status: "failed";
        code: KeychainBindingErrorCode;
        keyCleanupDebt: KeyCleanupDebt;
      }>
  > => {
    let created: KeychainBindingResponse;
    try {
      created = await transport.send({ op: "create-key", service });
    } catch {
      return { status: "failed", code: "unknown", keyCleanupDebt: "creation-rollback" };
    }
    if (!created.ok) {
      return {
        status: "failed",
        code: created.code,
        keyCleanupDebt:
          created.creationRollbackPending === false ? "none" : "creation-rollback",
      };
    }
    if (created.op !== "create-key") {
      return { status: "failed", code: "unknown", keyCleanupDebt: "creation-rollback" };
    }
    const key = Buffer.from(created.key);
    if (key.length === KEYCHAIN_KEY_BYTES) return { status: "ready", key };
    key.fill(0);
    return { status: "failed", code: "unknown", keyCleanupDebt: "creation-rollback" };
  };

  const readMaterial = async (): Promise<
    | Readonly<{ status: "ready"; key: Buffer }>
    | Readonly<{ status: "missing" }>
    | Readonly<{ status: "failed"; code: KeychainBindingErrorCode }>
  > => {
    const read = await transport.send({ op: "read-key", service });
    if (!read.ok) {
      return read.code === "item-not-found"
        ? { status: "missing" }
        : { status: "failed", code: read.code };
    }
    if (read.op !== "read-key") return { status: "failed", code: "unknown" };
    const key = Buffer.from(read.key);
    if (key.length === KEYCHAIN_KEY_BYTES) return { status: "ready", key };
    key.fill(0);
    return { status: "failed", code: "unknown" };
  };

  const deleteMaterialForReset = async (): Promise<KeychainKeyDeletion> => {
    const deleted = await transport.send({ op: "delete-key", service });
    if (!deleted.ok || deleted.op !== "delete-key") {
      return { status: "failed", code: deleted.ok ? "unknown" : deleted.code };
    }
    return { status: deleted.deleted ? "deleted" : "already-absent" };
  };

  const deleteMaterial = async (
    zeroProof: ZeroDeletionBlockerCensusProof,
  ): Promise<KeychainKeyDeletion> => {
    if (!isZeroDeletionBlockerCensusProof(zeroProof, options.lockProof)) {
      return { status: "failed", code: "unknown" };
    }
    return await deleteMaterialForReset();
  };

  const ready = (key: Buffer | null, createdKey: boolean): KeychainPartitionEncryptionResult => {
    const holder: KeyHolder = { key, failure: "item-not-found", cleanupDebt: "none" };
    const fail = (
      code: KeychainBindingErrorCode,
      keyCleanupDebt: KeyCleanupDebt = holder.cleanupDebt,
    ): KeychainKeyPreparation => {
      holder.failure = code;
      holder.cleanupDebt = keyCleanupDebt;
      return keyCleanupDebt === "none"
        ? { status: "failed", code }
        : { status: "failed", code, keyCleanupDebt };
    };
    const clearKey = (): void => {
      holder.key?.fill(0);
      holder.key = null;
    };
    const validateKey = async (
      proof: CredentialEnvelopeLockProof,
    ): Promise<KeychainKeyPreparation> => {
      if (proof !== options.lockProof) return fail("unknown");
      if (holder.key !== null) {
        const persisted = await readMaterial();
        if (persisted.status === "ready") {
          const matches = timingSafeEqual(holder.key, persisted.key);
          persisted.key.fill(0);
          if (matches) return { status: "ready" };
          clearKey();
          return fail("unknown");
        }
        clearKey();
        return fail(persisted.status === "missing" ? "item-not-found" : persisted.code);
      }
      return fail(holder.failure);
    };
    const prepareKey = async (
      proof: CredentialEnvelopeLockProof,
    ): Promise<KeychainKeyPreparation> => {
      if (proof !== options.lockProof) return fail("unknown");
      if (holder.key !== null) return await validateKey(proof);
      if (holder.cleanupDebt === "creation-rollback") {
        const retried = await retryCreationRollback();
        if (retried.status === "failed") return fail(retried.code, "creation-rollback");
        holder.cleanupDebt = "none";
      }
      if (holder.cleanupDebt === "retirement") {
        const inspection = await inspectAutomaticRetirement(proof);
        if (inspection.status === "failed" || inspection.zeroProof === null) {
          return fail("unknown", "retirement");
        }
        const deleted = await deleteMaterial(inspection.zeroProof);
        if (deleted.status === "failed") {
          return fail(deleted.code, "retirement");
        }
        holder.cleanupDebt = "none";
      }
      const existing = await readMaterial();
      if (existing.status === "ready") {
        holder.key = existing.key;
        holder.failure = "item-not-found";
        return { status: "ready" };
      }
      if (existing.status === "failed") {
        return fail(existing.code);
      }
      const inspection = await inspectAutomaticRetirement(proof);
      if (inspection.status === "failed") return fail("unknown");
      if (inspection.keychainDependents > 0) {
        return fail("item-not-found");
      }
      const created = await createMaterial();
      if (created.status === "failed") {
        return fail(created.code, created.keyCleanupDebt);
      }
      holder.key = created.key;
      holder.failure = "item-not-found";
      return { status: "ready" };
    };
    const retireKey = async (
      proof: CredentialEnvelopeLockProof,
    ): Promise<KeychainKeyRetirement> => {
      const inspection = await inspectAutomaticRetirement(proof);
      if (inspection.status === "failed") {
        clearKey();
        holder.failure = "unknown";
        holder.cleanupDebt = "none";
        return { status: "failed", code: "unknown", keyCleanupPending: false };
      }
      if (inspection.zeroProof === null) {
        return { status: "retained", envelopes: inspection.deletionBlockers };
      }
      const previous = holder.key;
      holder.key = null;
      const deleted = await deleteMaterial(inspection.zeroProof);
      if (deleted.status === "failed") {
        previous?.fill(0);
        holder.failure = deleted.code;
        holder.cleanupDebt = "retirement";
        return { ...deleted, keyCleanupPending: true };
      }
      previous?.fill(0);
      holder.failure = "item-not-found";
      holder.cleanupDebt = "none";
      return deleted;
    };
    const deleteKeyForReset = async (
      proof: CredentialEnvelopeLockProof,
    ): Promise<KeychainKeyDeletion> => {
      if (proof !== options.lockProof) return { status: "failed", code: "unknown" };
      const previous = holder.key;
      holder.key = null;
      const deleted = await deleteMaterialForReset();
      previous?.fill(0);
      if (deleted.status === "failed") {
        holder.failure = deleted.code;
        holder.cleanupDebt = "retirement";
        return deleted;
      }
      holder.failure = "item-not-found";
      holder.cleanupDebt = "none";
      return deleted;
    };
    return {
      status: "ready",
      encryption: readyPort(holder),
      createdKey,
      prepareKey,
      validateKey,
      retireKey,
      deleteKeyForReset,
    };
  };

  if (initialCleanupDebt === "retirement") {
    if (initialInspection.zeroProof === null) return refused("unknown", "retirement");
    const deleted = await deleteMaterial(initialInspection.zeroProof);
    return deleted.status === "failed"
      ? refused(deleted.code, "retirement")
      : ready(null, false);
  }

  const read = await readMaterial();
  if (read.status === "ready") {
    if (initialInspection.zeroProof === null) return ready(read.key, false);
    const deleted = await deleteMaterial(initialInspection.zeroProof);
    read.key.fill(0);
    return deleted.status === "failed"
      ? refused(deleted.code, "retirement")
      : ready(null, false);
  }
  if (read.status === "missing") {
    return initialInspection.keychainDependents > 0 ? refused("item-not-found") : ready(null, false);
  }
  return refused(read.code);
}
