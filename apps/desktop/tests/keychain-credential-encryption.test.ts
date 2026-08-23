import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createAutomaticKeyRetirementInspector,
  type InspectAutomaticKeyRetirement,
} from "../src/main/automatic-key-retirement.js";
import { createCredentialEnvelopeMutationLock } from "../src/main/credential-envelope-lock.js";
import {
  CREDENTIAL_ENVELOPE_IV_BYTES,
  CREDENTIAL_ENVELOPE_MAGIC,
  CREDENTIAL_ENVELOPE_TAG_BYTES,
  CredentialEnvelopeError,
  KEYCHAIN_ENVELOPE_KEY_ID,
  KEYCHAIN_PARTITION_STORAGE_BACKEND,
  KeychainEncryptionError,
  SAFE_STORAGE_ENVELOPE_KEY_ID,
  createKeychainPartitionEncryption,
  type CreateKeychainPartitionEncryptionOptions,
  openCredentialEnvelope,
  readCredentialEnvelopeKeyId,
  sealCredentialEnvelope,
} from "../src/main/keychain-credential-encryption.js";
import {
  KEYCHAIN_CREDENTIAL_SERVICE,
  KEYCHAIN_CREDENTIAL_SERVICE_DEV,
  KEYCHAIN_KEY_BYTES,
  KEYCHAIN_TEAM_IDENTIFIER,
  type KeychainBindingRequest,
  type KeychainBindingResponse,
  type KeychainBindingTransport,
} from "../src/main/keychain-binding.js";

const PROBE_OK: KeychainBindingResponse = {
  ok: true,
  op: "probe",
  teamIdentifier: KEYCHAIN_TEAM_IDENTIFIER,
};
const serializePreparedEncryption = createCredentialEnvelopeMutationLock();

interface RecordingTransport extends KeychainBindingTransport {
  readonly requests: KeychainBindingRequest[];
  readonly allRequests: KeychainBindingRequest[];
}

function transportOf(...responses: readonly KeychainBindingResponse[]): RecordingTransport {
  return transportWithRollbackRetries(responses, []);
}

function transportWithRollbackRetries(
  responses: readonly KeychainBindingResponse[],
  rollbackResponses: readonly KeychainBindingResponse[],
): RecordingTransport {
  const remaining = [...responses];
  const remainingRollback = [...rollbackResponses];
  const requests: KeychainBindingRequest[] = [];
  const allRequests: KeychainBindingRequest[] = [];
  return {
    requests,
    allRequests,
    send(request) {
      allRequests.push(request);
      if (request.op === "retry-created-key-rollback") {
        return Promise.resolve(
          remainingRollback.shift() ?? { ok: true, op: "retry-created-key-rollback" },
        );
      }
      requests.push(request);
      const next = remaining.shift();
      if (next === undefined) throw new Error("unexpected helper request");
      return Promise.resolve(next);
    },
  };
}

function storedKey(): { readonly key: Buffer; readonly encoded: Buffer } {
  const key = randomBytes(KEYCHAIN_KEY_BYTES);
  return { key, encoded: Buffer.from(key) };
}

async function createEncryption(
  options: Omit<
    CreateKeychainPartitionEncryptionOptions,
    "inspectAutomaticRetirement" | "lockProof"
  > & {
    readonly envelopeCensus?: TestEnvelopeCensus | (() => Promise<TestEnvelopeCensus>);
  },
) {
  const {
    envelopeCensus = { deletionBlockers: 1, keychainDependents: 1 },
    ...keychainOptions
  } = options;
  return await serializePreparedEncryption((lockProof) =>
    createKeychainPartitionEncryption({
      ...keychainOptions,
      inspectAutomaticRetirement: automaticRetirementInspector(envelopeCensus),
      lockProof,
    }),
  );
}

interface TestEnvelopeCensus {
  readonly deletionBlockers: number;
  readonly keychainDependents: number;
}

function automaticRetirementInspector(
  census: TestEnvelopeCensus | (() => Promise<TestEnvelopeCensus>),
): InspectAutomaticKeyRetirement {
  const nonce = randomBytes(12).toString("hex");
  const zeroInspector = createAutomaticKeyRetirementInspector({
    credentialRoot: join(tmpdir(), `missing-credential-${nonce}`),
    telegramRoot: join(tmpdir(), `missing-telegram-${nonce}`),
  });
  return async (proof) => {
    const current = typeof census === "function" ? await census() : census;
    if (current.deletionBlockers === 0) return await zeroInspector(proof);
    return {
      status: "inspected",
      deletionBlockers: current.deletionBlockers,
      keychainDependents: current.keychainDependents,
      unverified: 0,
      zeroProof: null,
    };
  };
}

describe("credential envelope", () => {
  it("seals a value under the keychain key-id and reads it back", () => {
    const { key } = storedKey();
    const envelope = sealCredentialEnvelope(key, "sk-secret-value");
    expect(envelope.subarray(0, CREDENTIAL_ENVELOPE_MAGIC.length).toString("ascii")).toBe(
      CREDENTIAL_ENVELOPE_MAGIC,
    );
    expect(readCredentialEnvelopeKeyId(envelope)).toBe(KEYCHAIN_ENVELOPE_KEY_ID);
    expect(readCredentialEnvelopeKeyId(envelope)).not.toBe(SAFE_STORAGE_ENVELOPE_KEY_ID);
    expect(envelope.includes(Buffer.from("sk-secret-value", "utf8"))).toBe(false);
    expect(openCredentialEnvelope(key, envelope)).toBe("sk-secret-value");
  });

  it("lays the envelope out as magic, key-id, iv, ciphertext, tag", () => {
    const { key } = storedKey();
    const envelope = sealCredentialEnvelope(key, "abcd");
    const overhead =
      CREDENTIAL_ENVELOPE_MAGIC.length +
      1 +
      CREDENTIAL_ENVELOPE_IV_BYTES +
      CREDENTIAL_ENVELOPE_TAG_BYTES;
    expect(envelope.length).toBe(overhead + Buffer.byteLength("abcd", "utf8"));
  });

  it("uses a fresh iv for every seal", () => {
    const { key } = storedKey();
    const first = sealCredentialEnvelope(key, "same");
    const second = sealCredentialEnvelope(key, "same");
    expect(first.equals(second)).toBe(false);
  });

  it("refuses a tampered ciphertext", () => {
    const { key } = storedKey();
    const envelope = sealCredentialEnvelope(key, "sk-secret-value");
    const target = CREDENTIAL_ENVELOPE_MAGIC.length + 1 + CREDENTIAL_ENVELOPE_IV_BYTES;
    envelope[target] ^= 0xff;
    expect(() => openCredentialEnvelope(key, envelope)).toThrow();
  });

  it("refuses another key", () => {
    const envelope = sealCredentialEnvelope(storedKey().key, "sk-secret-value");
    expect(() => openCredentialEnvelope(storedKey().key, envelope)).toThrow();
  });

  it("refuses a safeStorage-era envelope and foreign bytes", () => {
    const { key } = storedKey();
    const envelope = sealCredentialEnvelope(key, "sk-secret-value");
    const legacy = Buffer.from(envelope);
    legacy[CREDENTIAL_ENVELOPE_MAGIC.length] = SAFE_STORAGE_ENVELOPE_KEY_ID;
    expect(() => openCredentialEnvelope(key, legacy)).toThrow(CredentialEnvelopeError);
    expect(
      readCredentialEnvelopeKeyId(Buffer.from("v10 opaque safeStorage bytes")),
    ).toBeUndefined();
    expect(readCredentialEnvelopeKeyId(Buffer.alloc(4))).toBeUndefined();
    expect(() => openCredentialEnvelope(key, Buffer.alloc(4))).toThrow(CredentialEnvelopeError);
  });
});

describe("keychain partition backend", () => {
  it("adopts an existing key and reports its backend id", async () => {
    const { encoded } = storedKey();
    const transport = transportOf(PROBE_OK, { ok: true, op: "read-key", key: encoded });
    const result = await createEncryption({
      transport,
      service: KEYCHAIN_CREDENTIAL_SERVICE,
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.createdKey).toBe(false);
    expect(result.encryption.isEncryptionAvailable()).toBe(true);
    expect(result.encryption.getSelectedStorageBackend?.()).toBe(
      KEYCHAIN_PARTITION_STORAGE_BACKEND,
    );
    const sealed = result.encryption.encryptString("token-value");
    expect(result.encryption.decryptString(sealed)).toBe("token-value");
    expect(transport.requests.map((request) => request.op)).toEqual(["probe", "read-key"]);
    expect(
      transport.requests.every((request) => request.service === KEYCHAIN_CREDENTIAL_SERVICE),
    ).toBe(true);
    expect(JSON.stringify(transport.requests)).not.toContain(encoded);
  });

  it("revalidates the same persisted key before a later write", async () => {
    const { encoded } = storedKey();
    const transport = transportOf(
      PROBE_OK,
      { ok: true, op: "read-key", key: encoded },
      { ok: true, op: "read-key", key: Buffer.from(encoded) },
    );
    const result = await createEncryption({
      transport,
      service: KEYCHAIN_CREDENTIAL_SERVICE,
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;

    await expect(
      serializePreparedEncryption((proof) => result.prepareKey(proof)),
    ).resolves.toEqual({ status: "ready" });
    expect(result.encryption.isEncryptionAvailable()).toBe(true);
    expect(transport.requests.map((request) => request.op)).toEqual([
      "probe",
      "read-key",
      "read-key",
    ]);
  });

  it("refuses a write when the persisted key was replaced", async () => {
    const original = storedKey();
    const replacement = storedKey();
    const transport = transportOf(
      PROBE_OK,
      { ok: true, op: "read-key", key: original.encoded },
      { ok: true, op: "read-key", key: replacement.encoded },
    );
    const result = await createEncryption({
      transport,
      service: KEYCHAIN_CREDENTIAL_SERVICE,
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;

    await expect(
      serializePreparedEncryption((proof) => result.prepareKey(proof)),
    ).resolves.toEqual({ status: "failed", code: "unknown" });
    expect(result.encryption.isEncryptionAvailable()).toBe(false);
    expect(() => result.encryption.encryptString("must-not-seal")).toThrow(
      KeychainEncryptionError,
    );
    expect(transport.requests.map((request) => request.op)).toEqual([
      "probe",
      "read-key",
      "read-key",
    ]);
  });

  it("revalidates a removal without creating or deleting key material", async () => {
    const original = storedKey();
    const replacement = storedKey();
    const transport = transportOf(
      PROBE_OK,
      { ok: true, op: "read-key", key: original.encoded },
      { ok: true, op: "read-key", key: replacement.encoded },
    );
    const result = await createEncryption({
      transport,
      service: KEYCHAIN_CREDENTIAL_SERVICE,
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;

    await expect(
      serializePreparedEncryption((proof) => result.validateKey(proof)),
    ).resolves.toEqual({ status: "failed", code: "unknown" });
    expect(result.encryption.isEncryptionAvailable()).toBe(false);
    expect(transport.requests.map((request) => request.op)).toEqual([
      "probe",
      "read-key",
      "read-key",
    ]);
  });

  it("refuses a write when the persisted key disappeared", async () => {
    const original = storedKey();
    const transport = transportOf(
      PROBE_OK,
      { ok: true, op: "read-key", key: original.encoded },
      { ok: false, code: "item-not-found" },
    );
    const result = await createEncryption({
      transport,
      service: KEYCHAIN_CREDENTIAL_SERVICE,
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;

    await expect(
      serializePreparedEncryption((proof) => result.prepareKey(proof)),
    ).resolves.toEqual({ status: "failed", code: "item-not-found" });
    expect(result.encryption.isEncryptionAvailable()).toBe(false);
    expect(transport.requests.map((request) => request.op)).toEqual([
      "probe",
      "read-key",
      "read-key",
    ]);
  });

  it("refuses a write when no-interaction key revalidation is locked", async () => {
    const original = storedKey();
    const transport = transportOf(
      PROBE_OK,
      { ok: true, op: "read-key", key: original.encoded },
      { ok: false, code: "keychain-locked" },
    );
    const result = await createEncryption({
      transport,
      service: KEYCHAIN_CREDENTIAL_SERVICE,
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;

    await expect(
      serializePreparedEncryption((proof) => result.prepareKey(proof)),
    ).resolves.toEqual({ status: "failed", code: "keychain-locked" });
    expect(result.encryption.isEncryptionAvailable()).toBe(false);
    expect(transport.requests.map((request) => request.op)).toEqual([
      "probe",
      "read-key",
      "read-key",
    ]);
  });

  it("keeps an absent key missing until an explicit credential write", async () => {
    const { encoded } = storedKey();
    const transport = transportOf(
      PROBE_OK,
      { ok: false, code: "item-not-found" },
      { ok: false, code: "item-not-found" },
      { ok: true, op: "create-key", key: encoded },
    );
    const result = await createEncryption({
      transport,
      service: KEYCHAIN_CREDENTIAL_SERVICE_DEV,
      envelopeCensus: { deletionBlockers: 0, keychainDependents: 0 },
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.createdKey).toBe(false);
    expect(result.encryption.isEncryptionAvailable()).toBe(false);
    expect(transport.requests.map((request) => request.op)).toEqual(["probe", "read-key"]);

    await expect(
      serializePreparedEncryption((proof) => result.prepareKey(proof)),
    ).resolves.toEqual({
      status: "ready",
    });
    expect(result.encryption.isEncryptionAvailable()).toBe(true);
    expect(transport.requests.map((request) => request.op)).toEqual([
      "probe",
      "read-key",
      "read-key",
      "create-key",
    ]);
    expect(
      transport.requests.every((request) => request.service === KEYCHAIN_CREDENTIAL_SERVICE_DEV),
    ).toBe(true);
  });

  it("retries failed creation through exact rollback before another census or read", async () => {
    const replacement = storedKey();
    const transport = transportWithRollbackRetries(
      [
        PROBE_OK,
        { ok: false, code: "item-not-found" },
        { ok: false, code: "item-not-found" },
        {
          ok: false,
          code: "unreadable-item",
          creationRollbackPending: true,
        },
        { ok: false, code: "item-not-found" },
        { ok: true, op: "create-key", key: replacement.encoded },
      ],
      [
        { ok: true, op: "retry-created-key-rollback" },
        { ok: false, code: "keychain-locked" },
        { ok: true, op: "retry-created-key-rollback" },
      ],
    );
    const inspect = automaticRetirementInspector({
      deletionBlockers: 0,
      keychainDependents: 0,
    });
    let inspections = 0;
    const serialize = createCredentialEnvelopeMutationLock();
    const result = await serialize((lockProof) =>
      createKeychainPartitionEncryption({
        transport,
        service: KEYCHAIN_CREDENTIAL_SERVICE,
        inspectAutomaticRetirement: async (proof) => {
          inspections += 1;
          return await inspect(proof);
        },
        lockProof,
      }),
    );
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;

    await expect(serialize((proof) => result.prepareKey(proof))).resolves.toEqual({
      status: "failed",
      code: "unreadable-item",
      keyCleanupDebt: "creation-rollback",
    });
    expect(result.encryption.isEncryptionAvailable()).toBe(false);
    expect(() => result.encryption.encryptString("must-not-seal")).toThrow(
      KeychainEncryptionError,
    );
    const inspectionsBeforeRetry = inspections;
    await expect(serialize((proof) => result.prepareKey(proof))).resolves.toEqual({
      status: "failed",
      code: "keychain-locked",
      keyCleanupDebt: "creation-rollback",
    });
    expect(inspections).toBe(inspectionsBeforeRetry);
    expect(transport.allRequests.at(-1)?.op).toBe("retry-created-key-rollback");

    await expect(serialize((proof) => result.prepareKey(proof))).resolves.toEqual({
      status: "ready",
    });
    expect(transport.allRequests.map((request) => request.op)).toEqual([
      "probe",
      "retry-created-key-rollback",
      "read-key",
      "read-key",
      "create-key",
      "retry-created-key-rollback",
      "retry-created-key-rollback",
      "read-key",
      "create-key",
    ]);
    expect(transport.allRequests.some((request) => request.op === "delete-key")).toBe(false);
    expect(result.encryption.isEncryptionAvailable()).toBe(true);
  });

  it("does not record creation rollback debt after confirmed cleanup", async () => {
    const transport = transportOf(
      PROBE_OK,
      { ok: false, code: "item-not-found" },
      { ok: false, code: "item-not-found" },
      {
        ok: false,
        code: "unreadable-item",
        creationRollbackPending: false,
      },
    );
    const result = await createEncryption({
      transport,
      service: KEYCHAIN_CREDENTIAL_SERVICE,
      envelopeCensus: { deletionBlockers: 0, keychainDependents: 0 },
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;

    await expect(
      serializePreparedEncryption((proof) => result.prepareKey(proof)),
    ).resolves.toEqual({
      status: "failed",
      code: "unreadable-item",
    });
    expect(transport.requests.some((request) => request.op === "retry-created-key-rollback")).toBe(
      false,
    );
  });

  it("deletes a readable orphan but defers replacement until a write", async () => {
    const { encoded } = storedKey();
    const transport = transportOf(
      PROBE_OK,
      { ok: true, op: "read-key", key: encoded },
      { ok: true, op: "delete-key", deleted: true },
      { ok: false, code: "item-not-found" },
      { ok: true, op: "create-key", key: encoded },
    );
    const result = await createEncryption({
      transport,
      service: KEYCHAIN_CREDENTIAL_SERVICE,
      envelopeCensus: { deletionBlockers: 0, keychainDependents: 0 },
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.encryption.isEncryptionAvailable()).toBe(false);
    expect(transport.requests.map((request) => request.op)).toEqual([
      "probe",
      "read-key",
      "delete-key",
    ]);

    await expect(
      serializePreparedEncryption((proof) => result.prepareKey(proof)),
    ).resolves.toEqual({
      status: "ready",
    });
    expect(transport.requests.map((request) => request.op)).toEqual([
      "probe",
      "read-key",
      "delete-key",
      "read-key",
      "create-key",
    ]);
  });

  it("reports encryption as unavailable when the keychain is locked", async () => {
    const transport = transportOf(PROBE_OK, { ok: false, code: "keychain-locked" });
    const result = await createEncryption({
      transport,
      service: KEYCHAIN_CREDENTIAL_SERVICE,
      envelopeCensus: { deletionBlockers: 0, keychainDependents: 0 },
    });
    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") return;
    expect(result.code).toBe("keychain-locked");
    expect(result.encryption.isEncryptionAvailable()).toBe(false);
    expect(result.encryption.getSelectedStorageBackend?.()).toBe(
      KEYCHAIN_PARTITION_STORAGE_BACKEND,
    );
    expect(() => result.encryption.encryptString("token-value")).toThrow(KeychainEncryptionError);
  });

  it("reports a duplicate only when an explicit write tries to create the key", async () => {
    const transport = transportOf(
      PROBE_OK,
      { ok: false, code: "item-not-found" },
      { ok: false, code: "item-not-found" },
      { ok: false, code: "duplicate-item", creationRollbackPending: false },
    );
    const result = await createEncryption({
      transport,
      service: KEYCHAIN_CREDENTIAL_SERVICE,
      envelopeCensus: { deletionBlockers: 0, keychainDependents: 0 },
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(transport.requests.map((request) => request.op)).toEqual(["probe", "read-key"]);

    await expect(
      serializePreparedEncryption((proof) => result.prepareKey(proof)),
    ).resolves.toEqual({
      status: "failed",
      code: "duplicate-item",
    });
    expect(result.encryption.isEncryptionAvailable()).toBe(false);
    expect(() => result.encryption.encryptString("token-value")).toThrow(KeychainEncryptionError);
    expect(() => result.encryption.decryptString(Buffer.alloc(0))).toThrow(KeychainEncryptionError);
  });

  it("stops at the probe and touches no keychain op when the build is not team signed", async () => {
    const transport = transportOf({ ok: false, code: "not-team-signed" });
    const result = await createEncryption({
      transport,
      service: KEYCHAIN_CREDENTIAL_SERVICE,
    });
    expect(result).toEqual({
      status: "unsupported",
      code: "not-team-signed",
      keyCleanupDebt: "none",
    });
    expect(transport.requests.map((request) => request.op)).toEqual(["probe"]);
  });

  it("refuses a probe answered by a foreign team", async () => {
    const transport = transportOf({ ok: true, op: "probe", teamIdentifier: "ZZZZZZZZZZ" });
    const result = await createEncryption({
      transport,
      service: KEYCHAIN_CREDENTIAL_SERVICE,
    });
    expect(result.status).toBe("storage-failed");
    expect(transport.requests).toHaveLength(1);
  });

  it("refuses a helper key of the wrong size", async () => {
    const transport = transportOf(PROBE_OK, {
      ok: true,
      op: "read-key",
      key: randomBytes(16),
    });
    const result = await createEncryption({
      transport,
      service: KEYCHAIN_CREDENTIAL_SERVICE,
    });
    expect(result.status).toBe("storage-failed");
  });

  it("preserves an uninspectable item and reports encryption unavailable", async () => {
    const transport = transportOf(PROBE_OK, { ok: false, code: "uninspectable-item" });

    const result = await createEncryption({
      transport,
      service: KEYCHAIN_CREDENTIAL_SERVICE,
      envelopeCensus: { deletionBlockers: 2, keychainDependents: 1 },
    });

    expect(result.status).toBe("unavailable");
    expect(transport.requests.map((request) => request.op)).toEqual(["probe", "read-key"]);
  });

  it("preserves a missing key when dependent envelopes need recovery", async () => {
    const transport = transportOf(PROBE_OK, { ok: false, code: "item-not-found" });

    const result = await createEncryption({
      transport,
      service: KEYCHAIN_CREDENTIAL_SERVICE,
      envelopeCensus: { deletionBlockers: 1, keychainDependents: 1 },
    });

    expect(result.status).toBe("unavailable");
    expect(transport.requests.map((request) => request.op)).toEqual(["probe", "read-key"]);
  });

  it("preserves a positively invalid item while dependent envelopes survive", async () => {
    const transport = transportOf(PROBE_OK, { ok: false, code: "unreadable-item" });

    const result = await createEncryption({
      transport,
      service: KEYCHAIN_CREDENTIAL_SERVICE,
      envelopeCensus: { deletionBlockers: 1, keychainDependents: 1 },
    });

    expect(result.status).toBe("storage-failed");
    expect(transport.requests.map((request) => request.op)).toEqual(["probe", "read-key"]);
  });

  it("never deletes or replaces an unreadable item even with zero blockers", async () => {
    const transport = transportOf(PROBE_OK, { ok: false, code: "unreadable-item" });

    const result = await createEncryption({
      transport,
      service: KEYCHAIN_CREDENTIAL_SERVICE,
      envelopeCensus: { deletionBlockers: 0, keychainDependents: 0 },
    });

    expect(result.status).toBe("storage-failed");
    expect(transport.requests.map((request) => request.op)).toEqual(["probe", "read-key"]);
  });

  it("retries a failed deletion before creating a replacement", async () => {
    const original = storedKey();
    const replacement = storedKey();
    let census = { deletionBlockers: 1, keychainDependents: 1 };
    const transport = transportOf(
      PROBE_OK,
      { ok: true, op: "read-key", key: original.encoded },
      { ok: false, code: "unknown" },
      { ok: true, op: "delete-key", deleted: true },
      { ok: false, code: "item-not-found" },
      { ok: true, op: "create-key", key: replacement.encoded },
    );
    const serialize = createCredentialEnvelopeMutationLock();
    const result = await serialize((lockProof) =>
      createKeychainPartitionEncryption({
        transport,
        service: KEYCHAIN_CREDENTIAL_SERVICE,
        inspectAutomaticRetirement: automaticRetirementInspector(async () => census),
        lockProof,
      }),
    );
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;

    census = { deletionBlockers: 0, keychainDependents: 0 };
    await expect(serialize((proof) => result.retireKey(proof))).resolves.toEqual({
      status: "failed",
      code: "unknown",
      keyCleanupPending: true,
    });
    expect(result.encryption.isEncryptionAvailable()).toBe(false);
    expect(() => result.encryption.encryptString("orphan-candidate")).toThrow(
      KeychainEncryptionError,
    );

    await expect(serialize((proof) => result.prepareKey(proof))).resolves.toEqual({
      status: "ready",
    });
    expect(result.encryption.isEncryptionAvailable()).toBe(true);
    expect(transport.requests.map((request) => request.op)).toEqual([
      "probe",
      "read-key",
      "delete-key",
      "delete-key",
      "read-key",
      "create-key",
    ]);
    const sealed = result.encryption.encryptString("post-cleanup-secret");
    expect(openCredentialEnvelope(replacement.key, sealed)).toBe("post-cleanup-secret");
  });

  it("does not record cleanup debt when retirement inspection fails before deletion", async () => {
    const original = storedKey();
    let inspectionFails = false;
    const transport = transportOf(PROBE_OK, {
      ok: true,
      op: "read-key",
      key: original.encoded,
    });
    const serialize = createCredentialEnvelopeMutationLock();
    const result = await serialize((lockProof) =>
      createKeychainPartitionEncryption({
        transport,
        service: KEYCHAIN_CREDENTIAL_SERVICE,
        inspectAutomaticRetirement: async () =>
          inspectionFails
            ? { status: "failed" }
            : {
                status: "inspected",
                deletionBlockers: 1,
                keychainDependents: 1,
                unverified: 0,
                zeroProof: null,
              },
        lockProof,
      }),
    );
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;

    inspectionFails = true;
    await expect(serialize((proof) => result.retireKey(proof))).resolves.toEqual({
      status: "failed",
      code: "unknown",
      keyCleanupPending: false,
    });
    expect(result.encryption.isEncryptionAvailable()).toBe(false);
    expect(transport.requests.map((request) => request.op)).toEqual(["probe", "read-key"]);
  });

  it("refuses pending cleanup when a blocker appears", async () => {
    const original = storedKey();
    let census = { deletionBlockers: 1, keychainDependents: 1 };
    const transport = transportOf(
      PROBE_OK,
      { ok: true, op: "read-key", key: original.encoded },
      { ok: false, code: "unknown" },
    );
    const serialize = createCredentialEnvelopeMutationLock();
    const result = await serialize((lockProof) =>
      createKeychainPartitionEncryption({
        transport,
        service: KEYCHAIN_CREDENTIAL_SERVICE,
        inspectAutomaticRetirement: automaticRetirementInspector(async () => census),
        lockProof,
      }),
    );
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;

    census = { deletionBlockers: 0, keychainDependents: 0 };
    await expect(serialize((proof) => result.retireKey(proof))).resolves.toEqual({
      status: "failed",
      code: "unknown",
      keyCleanupPending: true,
    });
    census = { deletionBlockers: 1, keychainDependents: 0 };
    await expect(serialize((proof) => result.prepareKey(proof))).resolves.toEqual({
      status: "failed",
      code: "unknown",
      keyCleanupDebt: "retirement",
    });
    expect(transport.requests.map((request) => request.op)).toEqual([
      "probe",
      "read-key",
      "delete-key",
    ]);
    expect(result.encryption.isEncryptionAvailable()).toBe(false);
  });
});
