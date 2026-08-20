import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  keychainFailureRefusal,
  selectDesktopCredentialBackend,
  type SelectDesktopCredentialBackendOptions,
} from "../src/main/credential-backend-selection.js";
import { createCredentialEnvelopeMutationLock } from "../src/main/credential-envelope-lock.js";
import {
  createCredentialVault,
  type CredentialEncryptionPort,
  type DesktopCredentialSlot,
} from "../src/main/credential-vault.js";
import { credentialEnvelopeKeyId } from "../src/main/credential-envelope-inventory.js";
import {
  CREDENTIAL_ENVELOPE_MAGIC,
  KEYCHAIN_ENVELOPE_KEY_ID,
  KEYCHAIN_PARTITION_STORAGE_BACKEND,
  SAFE_STORAGE_ENVELOPE_KEY_ID,
  createKeychainPartitionEncryption,
} from "../src/main/keychain-credential-encryption.js";
import {
  KEYCHAIN_CREDENTIAL_SERVICE,
  KEYCHAIN_KEY_BYTES,
  KEYCHAIN_TEAM_IDENTIFIER,
  type KeychainHelperRequest,
  type KeychainHelperResponse,
  type KeychainHelperTransport,
} from "../src/main/keychain-helper.js";
import {
  TELEGRAM_PROFILE_FILE_NAME,
  createTelegramCredentialVault,
} from "../src/main/telegram-credential-vault.js";

const fixtureRoots: string[] = [];
const posixIt = it.skipIf(process.platform === "win32");
const BOT = { id: 123456, username: "synthetic_bot" } as const;
const PROBE_OK: KeychainHelperResponse = {
  ok: true,
  op: "probe",
  teamIdentifier: KEYCHAIN_TEAM_IDENTIFIER,
};

interface Fixture {
  readonly credentialRoot: string;
  readonly telegramRoot: string;
  readonly athleteHome: string;
}

async function fixture(): Promise<Fixture> {
  const base = await mkdtemp(join(await realpath(tmpdir()), "desktop-backend-selection-"));
  fixtureRoots.push(base);
  const home = join(base, "athlete-home");
  await mkdir(home, { mode: 0o700 });
  return {
    credentialRoot: join(base, "credentials-v1"),
    telegramRoot: join(base, "telegram-channel-v1"),
    athleteHome: await realpath(home),
  };
}

function safeStorage(): CredentialEncryptionPort {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) =>
      Buffer.concat([Buffer.from("SAFE:"), Buffer.from(value, "utf8").reverse()]),
    decryptString(value) {
      if (!value.subarray(0, 5).equals(Buffer.from("SAFE:"))) throw new TypeError();
      return Buffer.from(value.subarray(5)).reverse().toString("utf8");
    },
  };
}

interface RecordingTransport extends KeychainHelperTransport {
  readonly requests: KeychainHelperRequest[];
}

function transportOf(...responses: readonly KeychainHelperResponse[]): RecordingTransport {
  const remaining = [...responses];
  const requests: KeychainHelperRequest[] = [];
  return {
    requests,
    send(request) {
      requests.push(request);
      const next = remaining.shift();
      if (next === undefined) throw new Error("unexpected helper request");
      return Promise.resolve(next);
    },
  };
}

function readKey(key: Buffer): KeychainHelperResponse {
  return { ok: true, op: "read-key", key: key.toString("base64") };
}

async function keychainEncryption(key: Buffer): Promise<CredentialEncryptionPort> {
  const serialize = createCredentialEnvelopeMutationLock();
  const result = await serialize((lockProof) =>
    createKeychainPartitionEncryption({
      transport: transportOf(PROBE_OK, readKey(key)),
      service: KEYCHAIN_CREDENTIAL_SERVICE,
      dependentEnvelopes: 0,
      lockProof,
    }),
  );
  if (result.status !== "ready") throw new TypeError();
  return result.encryption;
}

function selection(
  roots: Fixture,
  transport: KeychainHelperTransport,
): SelectDesktopCredentialBackendOptions {
  return {
    credentialRoot: roots.credentialRoot,
    telegramRoot: roots.telegramRoot,
    transport,
    service: KEYCHAIN_CREDENTIAL_SERVICE,
    safeStorage: safeStorage(),
    platform: "darwin",
    serializeEnvelopeMutation: createCredentialEnvelopeMutationLock(),
  };
}

async function seedCredential(
  root: string,
  slot: DesktopCredentialSlot,
  value: string,
  encryption: CredentialEncryptionPort,
): Promise<void> {
  const vault = createCredentialVault({
    root,
    encryption,
    applyCredential: vi.fn(async () => undefined),
  });
  await expect(vault.writeCredential({ slot, value }, { activate: false })).resolves.toMatchObject({
    status: "configured",
  });
}

async function seedProfile(
  roots: Fixture,
  token: string,
  encryption: CredentialEncryptionPort,
): Promise<void> {
  const vault = createTelegramCredentialVault({
    root: roots.telegramRoot,
    athleteHome: roots.athleteHome,
    encryption,
  });
  await expect(
    vault.replaceProfile({ token, bot: BOT, authenticatedAthleteHome: roots.athleteHome }),
  ).resolves.toMatchObject({ outcome: "applied" });
}

function credentialVault(roots: Fixture, encryption: CredentialEncryptionPort) {
  return createCredentialVault({
    root: roots.credentialRoot,
    encryption,
    applyCredential: vi.fn(async () => undefined),
  });
}

function telegramVault(roots: Fixture, encryption: CredentialEncryptionPort) {
  return createTelegramCredentialVault({
    root: roots.telegramRoot,
    athleteHome: roots.athleteHome,
    encryption,
  });
}

afterEach(async () => {
  for (const root of fixtureRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("backend selection", () => {
  posixIt("selects the keychain backend on a team-signed darwin build", async () => {
    const roots = await fixture();
    const transport = transportOf(PROBE_OK, readKey(randomBytes(KEYCHAIN_KEY_BYTES)));

    const selected = await selectDesktopCredentialBackend(selection(roots, transport));

    expect(selected.status).toBe("keychain");
    if (selected.status !== "keychain") return;
    expect(selected.encryption.getSelectedStorageBackend?.()).toBe(
      KEYCHAIN_PARTITION_STORAGE_BACKEND,
    );
    expect(selected.migration).toEqual({
      status: "complete",
      migrated: 0,
      alreadyMigrated: 0,
      failed: 0,
      uncertain: 0,
    });
    expect(transport.requests.map((request) => request.op)).toEqual(["probe", "read-key"]);
  });

  posixIt("keeps safeStorage on a build that carries no team identity", async () => {
    const roots = await fixture();
    const legacy = safeStorage();
    await seedCredential(roots.credentialRoot, "anthropic", "sk-anthropic", legacy);
    const transport = transportOf({ ok: false, code: "not-team-signed" });
    const options = { ...selection(roots, transport), safeStorage: legacy };

    const selected = await selectDesktopCredentialBackend(options);

    expect(selected.status).toBe("safe-storage");
    expect(selected.encryption).toBe(legacy);
    expect(transport.requests.map((request) => request.op)).toEqual(["probe"]);
  });

  posixIt("keeps safeStorage off darwin without probing the helper", async () => {
    const roots = await fixture();
    const transport = transportOf();

    const selected = await selectDesktopCredentialBackend({
      ...selection(roots, transport),
      platform: "win32",
    });

    expect(selected.status).toBe("safe-storage");
    expect(transport.requests).toHaveLength(0);
  });

  posixIt("migrates eagerly at the first startup on the keychain backend", async () => {
    const roots = await fixture();
    const legacy = safeStorage();
    const key = randomBytes(KEYCHAIN_KEY_BYTES);
    await seedCredential(roots.credentialRoot, "anthropic", "sk-anthropic", legacy);
    await seedProfile(roots, "synthetic-token", legacy);
    const transport = transportOf(
      PROBE_OK,
      { ok: false, code: "item-not-found" },
      { ok: true, op: "create-key", key: key.toString("base64") },
    );
    const options = {
      ...selection(roots, transport),
      safeStorage: legacy,
    };

    const selected = await selectDesktopCredentialBackend(options);

    expect(selected.status).toBe("keychain");
    if (selected.status !== "keychain") return;
    expect(selected.migration).toMatchObject({ status: "complete", migrated: 2 });
    for (const path of [
      join(roots.credentialRoot, "anthropic.bin"),
      join(roots.telegramRoot, TELEGRAM_PROFILE_FILE_NAME),
    ]) {
      expect(credentialEnvelopeKeyId(await readFile(path))).toBe(KEYCHAIN_ENVELOPE_KEY_ID);
    }
    await expect(credentialVault(roots, selected.encryption).credentialStatuses()).resolves.toEqual(
      expect.arrayContaining([
        { slot: "anthropic", state: "configured", runtimeState: "stored-inactive" },
      ]),
    );
    await expect(telegramVault(roots, selected.encryption).profileStatus()).resolves.toMatchObject({
      state: "configured",
    });
    expect(transport.requests.map((request) => request.op)).toEqual([
      "probe",
      "read-key",
      "create-key",
    ]);
  });
});

describe("unreadable envelopes", () => {
  posixIt("reports the pass incomplete when an envelope cannot be read", async () => {
    const roots = await fixture();
    const legacy = safeStorage();
    await seedCredential(roots.credentialRoot, "anthropic", "sk-anthropic", legacy);

    const selected = await selectDesktopCredentialBackend({
      ...selection(roots, transportOf(PROBE_OK, readKey(randomBytes(KEYCHAIN_KEY_BYTES)))),
      safeStorage: legacy,
      readEnvelopeFile: (async (path: string) => {
        if (path.endsWith("anthropic.bin")) {
          throw Object.assign(new Error("synthetic read failure"), { code: "EACCES" });
        }
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }) as never,
    });

    expect(selected.status).toBe("keychain");
    if (selected.status !== "keychain") return;
    expect(selected.migration).toEqual({
      status: "incomplete",
      migrated: 0,
      alreadyMigrated: 0,
      failed: 1,
      uncertain: 0,
    });
    expect(
      credentialEnvelopeKeyId(await readFile(join(roots.credentialRoot, "anthropic.bin"))),
    ).toBe(SAFE_STORAGE_ENVELOPE_KEY_ID);
    expect(selected.encryption.decryptString(legacy.encryptString("sk-old"))).toBe("sk-old");
  });
});

describe("mandatory keychain rule", () => {
  posixIt("refuses to fall back to safeStorage once an envelope is migrated", async () => {
    const roots = await fixture();
    const legacy = safeStorage();
    const key = randomBytes(KEYCHAIN_KEY_BYTES);
    await seedCredential(roots.credentialRoot, "anthropic", "sk-anthropic", legacy);
    await seedProfile(roots, "synthetic-token", legacy);
    await selectDesktopCredentialBackend({
      ...selection(roots, transportOf(PROBE_OK, readKey(key))),
      safeStorage: legacy,
    });
    const migrated = await readFile(join(roots.credentialRoot, "anthropic.bin"));

    const selected = await selectDesktopCredentialBackend({
      ...selection(roots, transportOf({ ok: false, code: "not-team-signed" })),
      safeStorage: legacy,
    });

    expect(selected.status).toBe("refused");
    if (selected.status !== "refused") return;
    expect(selected.reason).toBe("encryption-unavailable");
    expect(selected.code).toBe("not-team-signed");
    expect(selected.encryption.isEncryptionAvailable()).toBe(false);
    expect(selected.encryption.getSelectedStorageBackend?.()).toBe(
      KEYCHAIN_PARTITION_STORAGE_BACKEND,
    );
    await expect(readFile(join(roots.credentialRoot, "anthropic.bin"))).resolves.toEqual(migrated);
  });

  posixIt(
    "reports a broken helper as encryption-unavailable once an envelope is migrated",
    async () => {
      const roots = await fixture();
      const legacy = safeStorage();
      const key = randomBytes(KEYCHAIN_KEY_BYTES);
      await seedCredential(roots.credentialRoot, "anthropic", "sk-anthropic", legacy);
      await selectDesktopCredentialBackend({
        ...selection(roots, transportOf(PROBE_OK, readKey(key))),
        safeStorage: legacy,
      });

      const selected = await selectDesktopCredentialBackend({
        ...selection(roots, transportOf({ ok: false, code: "unknown" })),
        safeStorage: legacy,
      });

      expect(selected.status).toBe("refused");
      if (selected.status !== "refused") return;
      expect(selected.reason).toBe("encryption-unavailable");
      expect(selected.code).toBe("unknown");
      expect(selected.encryption.isEncryptionAvailable()).toBe(false);
    },
  );

  posixIt("keeps a broken helper as storage-failed before any envelope is migrated", async () => {
    const roots = await fixture();
    const legacy = safeStorage();
    await seedCredential(roots.credentialRoot, "anthropic", "sk-anthropic", legacy);

    const selected = await selectDesktopCredentialBackend({
      ...selection(roots, transportOf({ ok: false, code: "unknown" })),
      safeStorage: legacy,
    });

    expect(selected.status).toBe("refused");
    if (selected.status !== "refused") return;
    expect(selected.reason).toBe("storage-failed");
    expect(selected.encryption.isEncryptionAvailable()).toBe(true);
  });

  posixIt("refuses when an existing envelope cannot be read", async () => {
    const roots = await fixture();
    const legacy = safeStorage();
    await seedCredential(roots.credentialRoot, "anthropic", "sk-anthropic", legacy);

    const selected = await selectDesktopCredentialBackend({
      ...selection(roots, transportOf({ ok: false, code: "not-team-signed" })),
      safeStorage: legacy,
      readEnvelopeFile: (async () => {
        throw Object.assign(new Error("synthetic read failure"), { code: "EACCES" });
      }) as never,
    });

    expect(selected.status).toBe("refused");
  });

  posixIt("leaves every credential untouched when the probe fails after migration", async () => {
    const roots = await fixture();
    const legacy = safeStorage();
    const key = randomBytes(KEYCHAIN_KEY_BYTES);
    await seedCredential(roots.credentialRoot, "anthropic", "sk-anthropic", legacy);
    await seedProfile(roots, "synthetic-token", legacy);
    await selectDesktopCredentialBackend({
      ...selection(roots, transportOf(PROBE_OK, readKey(key))),
      safeStorage: legacy,
    });
    const selected = await selectDesktopCredentialBackend({
      ...selection(roots, transportOf({ ok: false, code: "not-team-signed" })),
      safeStorage: legacy,
    });
    if (selected.status !== "refused") throw new TypeError();

    await expect(
      credentialVault(roots, selected.encryption).writeCredential({
        slot: "anthropic",
        value: "sk-replacement",
      }),
    ).resolves.toEqual({
      slot: "anthropic",
      status: "refused",
      reason: "encryption-unavailable",
    });
    await expect(telegramVault(roots, selected.encryption).profileStatus()).resolves.toEqual({
      state: "re-prompt",
      reason: "encryption-unavailable",
    });
    expect(
      credentialEnvelopeKeyId(await readFile(join(roots.credentialRoot, "anthropic.bin"))),
    ).toBe(KEYCHAIN_ENVELOPE_KEY_ID);
  });
});

describe("keychain failure mapping", () => {
  it("maps every helper error code onto the existing taxonomy", () => {
    expect(keychainFailureRefusal("keychain-locked", false)).toBe("encryption-unavailable");
    expect(keychainFailureRefusal("not-team-signed", false)).toBe("encryption-unavailable");
    expect(keychainFailureRefusal("duplicate-item", false)).toBe("storage-failed");
    expect(keychainFailureRefusal("unreadable-item", false)).toBe("storage-failed");
    expect(keychainFailureRefusal("item-not-found", false)).toBe("storage-failed");
    expect(keychainFailureRefusal("uninspectable-item", false)).toBe("encryption-unavailable");
    expect(keychainFailureRefusal("unknown", false)).toBe("storage-failed");
    expect(keychainFailureRefusal("keychain-locked", true)).toBe("encryption-unavailable");
    expect(keychainFailureRefusal("not-team-signed", true)).toBe("encryption-unavailable");
    expect(keychainFailureRefusal("unknown", true)).toBe("encryption-unavailable");
    expect(keychainFailureRefusal("duplicate-item", true)).toBe("storage-failed");
    expect(keychainFailureRefusal("unreadable-item", true)).toBe("encryption-unavailable");
    expect(keychainFailureRefusal("item-not-found", true)).toBe("encryption-unavailable");
    expect(keychainFailureRefusal("uninspectable-item", true)).toBe("encryption-unavailable");
  });

  posixIt("maps a locked keychain onto encryption-unavailable in both vaults", async () => {
    const roots = await fixture();
    const transport = transportOf(PROBE_OK, { ok: false, code: "keychain-locked" });

    const selected = await selectDesktopCredentialBackend(selection(roots, transport));

    expect(selected).toMatchObject({
      status: "refused",
      reason: "encryption-unavailable",
      code: "keychain-locked",
    });
    if (selected.status !== "refused") return;
    await expect(
      credentialVault(roots, selected.encryption).writeCredential({
        slot: "anthropic",
        value: "sk-anthropic",
      }),
    ).resolves.toEqual({
      slot: "anthropic",
      status: "refused",
      reason: "encryption-unavailable",
    });
    await expect(
      telegramVault(roots, selected.encryption).replaceProfile({
        token: "synthetic-token",
        bot: BOT,
        authenticatedAthleteHome: roots.athleteHome,
      }),
    ).resolves.toEqual({ outcome: "refused", reason: "encryption-unavailable" });
  });

  posixIt("maps a duplicate item on create onto storage-failed in both vaults", async () => {
    const roots = await fixture();
    const transport = transportOf(
      PROBE_OK,
      { ok: false, code: "item-not-found" },
      { ok: false, code: "duplicate-item" },
    );

    const selected = await selectDesktopCredentialBackend(selection(roots, transport));

    expect(selected).toMatchObject({
      status: "refused",
      reason: "storage-failed",
      code: "duplicate-item",
    });
    if (selected.status !== "refused") return;
    expect(selected.encryption.isEncryptionAvailable()).toBe(true);
    await expect(
      credentialVault(roots, selected.encryption).writeCredential({
        slot: "anthropic",
        value: "sk-anthropic",
      }),
    ).resolves.toEqual({ slot: "anthropic", status: "refused", reason: "storage-failed" });
    await expect(
      telegramVault(roots, selected.encryption).replaceProfile({
        token: "synthetic-token",
        bot: BOT,
        authenticatedAthleteHome: roots.athleteHome,
      }),
    ).resolves.toEqual({ outcome: "refused", reason: "storage-failed" });
  });

  posixIt("preserves an invalid item while dependent envelopes need recovery", async () => {
    const roots = await fixture();
    const retired = await keychainEncryption(randomBytes(KEYCHAIN_KEY_BYTES));
    await seedCredential(roots.credentialRoot, "anthropic", "sk-anthropic", retired);
    await seedProfile(roots, "synthetic-token", retired);
    const transport = transportOf(PROBE_OK, { ok: false, code: "unreadable-item" });

    const selected = await selectDesktopCredentialBackend(selection(roots, transport));

    expect(selected).toMatchObject({
      status: "refused",
      reason: "encryption-unavailable",
      code: "unreadable-item",
    });
    expect(transport.requests.map((request) => request.op)).toEqual(["probe", "read-key"]);
  });

  posixIt("preserves missing-key envelopes for explicit recovery", async () => {
    const roots = await fixture();
    const retired = await keychainEncryption(randomBytes(KEYCHAIN_KEY_BYTES));
    await seedCredential(roots.credentialRoot, "anthropic", "sk-anthropic", retired);
    const transport = transportOf(PROBE_OK, { ok: false, code: "item-not-found" });

    const selected = await selectDesktopCredentialBackend(selection(roots, transport));

    expect(selected).toMatchObject({
      status: "refused",
      reason: "encryption-unavailable",
      code: "item-not-found",
    });
    expect(transport.requests.map((request) => request.op)).toEqual(["probe", "read-key"]);
  });

  posixIt(
    "preserves an unrecognized envelope when legacy decryption cannot prove ownership",
    async () => {
      const roots = await fixture();
      const retired = await keychainEncryption(randomBytes(KEYCHAIN_KEY_BYTES));
      await seedCredential(roots.credentialRoot, "anthropic", "sk-anthropic", retired);
      const path = join(roots.credentialRoot, "anthropic.bin");
      const damaged = await readFile(path);
      damaged[0] ^= 0xff;
      await writeFile(path, damaged);
      damaged.fill(0);
      const transport = transportOf(PROBE_OK, { ok: false, code: "unreadable-item" });

      const selected = await selectDesktopCredentialBackend(selection(roots, transport));

      expect(selected).toMatchObject({
        status: "refused",
        reason: "encryption-unavailable",
        code: "unreadable-item",
      });
      expect(transport.requests.map((request) => request.op)).toEqual(["probe", "read-key"]);
    },
  );

  posixIt(
    "preserves a key-id zero envelope when legacy decryption cannot prove ownership",
    async () => {
      const roots = await fixture();
      const retired = await keychainEncryption(randomBytes(KEYCHAIN_KEY_BYTES));
      await seedCredential(roots.credentialRoot, "anthropic", "sk-anthropic", retired);
      const path = join(roots.credentialRoot, "anthropic.bin");
      const damaged = await readFile(path);
      damaged[CREDENTIAL_ENVELOPE_MAGIC.length] = SAFE_STORAGE_ENVELOPE_KEY_ID;
      await writeFile(path, damaged);
      damaged.fill(0);
      const transport = transportOf(PROBE_OK, { ok: false, code: "unreadable-item" });

      const selected = await selectDesktopCredentialBackend(selection(roots, transport));

      expect(selected).toMatchObject({
        status: "refused",
        reason: "encryption-unavailable",
        code: "unreadable-item",
      });
      expect(transport.requests.map((request) => request.op)).toEqual(["probe", "read-key"]);
    },
  );

  posixIt("keeps a partly migrated vault readable and writes only keychain envelopes", async () => {
    const roots = await fixture();
    const legacy = safeStorage();
    await seedCredential(roots.credentialRoot, "anthropic", "sk-anthropic", legacy);
    await seedCredential(roots.credentialRoot, "openrouter", "sk-openrouter", legacy);
    let renames = 0;

    const selected = await selectDesktopCredentialBackend({
      ...selection(roots, transportOf(PROBE_OK, readKey(randomBytes(KEYCHAIN_KEY_BYTES)))),
      safeStorage: legacy,
      renameFile: (async (from: string, to: string) => {
        renames += 1;
        if (renames > 1) throw new TypeError("synthetic rename failure");
        await rename(from, to);
      }) as never,
    });

    expect(selected.status).toBe("keychain");
    if (selected.status !== "keychain") return;
    expect(selected.migration).toMatchObject({ status: "incomplete", migrated: 1, failed: 1 });
    expect(
      credentialEnvelopeKeyId(await readFile(join(roots.credentialRoot, "anthropic.bin"))),
    ).toBe(KEYCHAIN_ENVELOPE_KEY_ID);
    expect(
      credentialEnvelopeKeyId(await readFile(join(roots.credentialRoot, "openrouter.bin"))),
    ).toBe(SAFE_STORAGE_ENVELOPE_KEY_ID);
    await expect(credentialVault(roots, selected.encryption).credentialStatuses()).resolves.toEqual(
      expect.arrayContaining([
        { slot: "anthropic", state: "configured", runtimeState: "stored-inactive" },
        { slot: "openrouter", state: "configured", runtimeState: "stored-inactive" },
      ]),
    );
    expect(credentialEnvelopeKeyId(selected.encryption.encryptString("sk-new"))).toBe(
      KEYCHAIN_ENVELOPE_KEY_ID,
    );
  });
});
