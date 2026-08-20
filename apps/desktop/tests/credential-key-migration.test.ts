import { randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCredentialVault,
  type CredentialEncryptionPort,
  type DesktopCredentialSlot,
} from "../src/main/credential-vault.js";
import {
  credentialEnvelopeKeyId,
  scanCredentialEnvelopes,
} from "../src/main/credential-envelope-inventory.js";
import { createCredentialEnvelopeMutationLock } from "../src/main/credential-envelope-lock.js";
import {
  createLegacyReadFallbackEncryption,
  migrateCredentialEnvelopes,
} from "../src/main/credential-key-migration.js";
import {
  KEYCHAIN_ENVELOPE_KEY_ID,
  KEYCHAIN_PARTITION_STORAGE_BACKEND,
  SAFE_STORAGE_ENVELOPE_KEY_ID,
  createKeychainPartitionEncryption,
} from "../src/main/keychain-credential-encryption.js";
import {
  KEYCHAIN_CREDENTIAL_SERVICE,
  KEYCHAIN_KEY_BYTES,
  KEYCHAIN_TEAM_IDENTIFIER,
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

interface Fixture {
  readonly credentialRoot: string;
  readonly telegramRoot: string;
  readonly athleteHome: string;
}

async function fixture(): Promise<Fixture> {
  const base = await mkdtemp(join(await realpath(tmpdir()), "desktop-credential-migration-"));
  fixtureRoots.push(base);
  const home = join(base, "athlete-home");
  await mkdir(home, { mode: 0o700 });
  return {
    credentialRoot: join(base, "credentials-v1"),
    telegramRoot: join(base, "telegram-channel-v1"),
    athleteHome: await realpath(home),
  };
}

interface SafeStorageSpy {
  readonly port: CredentialEncryptionPort;
  decryptCalls: number;
}

function safeStorage(): SafeStorageSpy {
  const spy: SafeStorageSpy = {
    decryptCalls: 0,
    port: {
      isEncryptionAvailable: () => true,
      encryptString: (value) =>
        Buffer.concat([Buffer.from("SAFE:"), Buffer.from(value, "utf8").reverse()]),
      decryptString(value) {
        spy.decryptCalls += 1;
        if (!value.subarray(0, 5).equals(Buffer.from("SAFE:"))) throw new TypeError();
        return Buffer.from(value.subarray(5)).reverse().toString("utf8");
      },
    },
  };
  return spy;
}

function transportOf(...responses: readonly KeychainHelperResponse[]): KeychainHelperTransport {
  const remaining = [...responses];
  return {
    send() {
      const next = remaining.shift();
      if (next === undefined) throw new Error("unexpected helper request");
      return Promise.resolve(next);
    },
  };
}

async function keychainEncryption(
  key: Buffer = randomBytes(KEYCHAIN_KEY_BYTES),
): Promise<CredentialEncryptionPort> {
  const serialize = createCredentialEnvelopeMutationLock();
  const result = await serialize((lockProof) =>
    createKeychainPartitionEncryption({
      transport: transportOf(
        { ok: true, op: "probe", teamIdentifier: KEYCHAIN_TEAM_IDENTIFIER },
        { ok: true, op: "read-key", key: key.toString("base64") },
      ),
      service: KEYCHAIN_CREDENTIAL_SERVICE,
      dependentEnvelopes: 0,
      lockProof,
    }),
  );
  if (result.status !== "ready") throw new TypeError();
  return result.encryption;
}

function refuseValue(port: CredentialEncryptionPort, refused: string): CredentialEncryptionPort {
  return {
    ...port,
    encryptString(value) {
      if (value === refused) throw new TypeError("synthetic seal failure");
      return port.encryptString(value);
    },
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
    slot,
    status: "configured",
  });
}

async function seedProfile(
  fixtureRoot: Fixture,
  token: string,
  encryption: CredentialEncryptionPort,
): Promise<void> {
  const vault = createTelegramCredentialVault({
    root: fixtureRoot.telegramRoot,
    athleteHome: fixtureRoot.athleteHome,
    encryption,
  });
  await expect(
    vault.replaceProfile({
      token,
      bot: BOT,
      authenticatedAthleteHome: fixtureRoot.athleteHome,
    }),
  ).resolves.toMatchObject({ outcome: "applied" });
}

async function keyIdOf(path: string): Promise<number> {
  return credentialEnvelopeKeyId(await readFile(path));
}

afterEach(async () => {
  for (const root of fixtureRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("credential envelope inventory", () => {
  posixIt("reports every seeded envelope with its key-id", async () => {
    const roots = await fixture();
    const legacy = safeStorage();
    const keychain = await keychainEncryption();
    await seedCredential(roots.credentialRoot, "anthropic", "sk-legacy", legacy.port);
    await seedCredential(roots.credentialRoot, "openrouter", "sk-migrated", keychain);
    await seedProfile(roots, "synthetic-token", legacy.port);

    const inventory = await scanCredentialEnvelopes({
      ...roots,
      classifyLegacyEnvelope(envelope) {
        try {
          return legacy.port.decryptString(envelope).length > 0;
        } catch {
          return false;
        }
      },
    });

    expect(inventory.envelopes.map((envelope) => envelope.fileName)).toEqual([
      "anthropic.bin",
      "openrouter.bin",
      TELEGRAM_PROFILE_FILE_NAME,
    ]);
    expect(inventory.envelopes.map((envelope) => envelope.keyId)).toEqual([
      SAFE_STORAGE_ENVELOPE_KEY_ID,
      KEYCHAIN_ENVELOPE_KEY_ID,
      SAFE_STORAGE_ENVELOPE_KEY_ID,
    ]);
    expect(inventory.legacy).toHaveLength(2);
    expect(inventory.migrated).toBe(1);
    expect(inventory.unreadable).toBe(0);
  });

  posixIt("does not require the keychain while every envelope is safeStorage-era", async () => {
    const roots = await fixture();
    const legacy = safeStorage();
    await seedCredential(roots.credentialRoot, "anthropic", "sk-legacy", legacy.port);
    await seedProfile(roots, "synthetic-token", legacy.port);

    await expect(
      scanCredentialEnvelopes({
        ...roots,
        classifyLegacyEnvelope(envelope) {
          try {
            return legacy.port.decryptString(envelope).length > 0;
          } catch {
            return false;
          }
        },
      }),
    ).resolves.toMatchObject({
      keychainRequired: false,
      migrated: 0,
    });
    await expect(scanCredentialEnvelopes(await fixture())).resolves.toMatchObject({
      keychainRequired: false,
      envelopes: [],
    });
  });

  posixIt("requires positive legacy decryption before excluding an unknown envelope", async () => {
    const roots = await fixture();
    const legacy = safeStorage();
    await seedCredential(roots.credentialRoot, "anthropic", "sk-legacy", legacy.port);

    await expect(scanCredentialEnvelopes(roots)).resolves.toMatchObject({
      keychainRequired: true,
      legacy: [],
      unreadable: 1,
    });
    await expect(
      scanCredentialEnvelopes({
        ...roots,
        classifyLegacyEnvelope: (envelope) => legacy.port.decryptString(envelope).length > 0,
      }),
    ).resolves.toMatchObject({
      keychainRequired: false,
      unreadable: 0,
    });
  });

  posixIt("requires the keychain once any envelope carries a non-zero key-id", async () => {
    const roots = await fixture();
    await seedCredential(roots.credentialRoot, "anthropic", "sk-legacy", safeStorage().port);
    await seedProfile(roots, "synthetic-token", await keychainEncryption());

    await expect(scanCredentialEnvelopes(roots)).resolves.toMatchObject({
      keychainRequired: true,
      migrated: 1,
    });
  });

  posixIt("requires the keychain when an existing envelope cannot be read", async () => {
    const roots = await fixture();
    await seedCredential(roots.credentialRoot, "anthropic", "sk-legacy", safeStorage().port);

    const inventory = await scanCredentialEnvelopes({
      ...roots,
      readEnvelopeFile: (async (path: string) => {
        if (typeof path === "string" && path.endsWith("anthropic.bin")) {
          throw Object.assign(new Error("synthetic read failure"), { code: "EACCES" });
        }
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }) as never,
    });

    expect(inventory).toMatchObject({ keychainRequired: true, unreadable: 1, migrated: 0 });
    expect(inventory.legacy).toHaveLength(0);
  });
});

describe("eager credential migration", () => {
  posixIt("migrates nothing on a fresh vault", async () => {
    const roots = await fixture();
    const legacy = safeStorage();

    await expect(
      migrateCredentialEnvelopes({
        ...roots,
        legacy: legacy.port,
        keychain: await keychainEncryption(),
      }),
    ).resolves.toEqual({
      status: "complete",
      migrated: 0,
      alreadyMigrated: 0,
      failed: 0,
      uncertain: 0,
    });
    expect(legacy.decryptCalls).toBe(0);
  });

  posixIt("migrates every legacy envelope and reads it back under the keychain key", async () => {
    const roots = await fixture();
    const legacy = safeStorage();
    const keychain = await keychainEncryption();
    await seedCredential(roots.credentialRoot, "anthropic", "sk-anthropic", legacy.port);
    await seedCredential(roots.credentialRoot, "openrouter", "sk-openrouter", legacy.port);
    await seedProfile(roots, "synthetic-token", legacy.port);

    await expect(
      migrateCredentialEnvelopes({ ...roots, legacy: legacy.port, keychain }),
    ).resolves.toEqual({
      status: "complete",
      migrated: 3,
      alreadyMigrated: 0,
      failed: 0,
      uncertain: 0,
    });

    await expect(scanCredentialEnvelopes(roots)).resolves.toMatchObject({
      migrated: 3,
      legacy: [],
      keychainRequired: true,
    });
    const vault = createCredentialVault({
      root: roots.credentialRoot,
      encryption: keychain,
      applyCredential: vi.fn(async () => undefined),
    });
    await expect(vault.credentialStatuses()).resolves.toEqual(
      expect.arrayContaining([
        { slot: "anthropic", state: "configured", runtimeState: "stored-inactive" },
        { slot: "openrouter", state: "configured", runtimeState: "stored-inactive" },
      ]),
    );
    const telegram = createTelegramCredentialVault({
      root: roots.telegramRoot,
      athleteHome: roots.athleteHome,
      encryption: keychain,
    });
    await expect(telegram.profileStatus()).resolves.toMatchObject({
      state: "configured",
      bot: BOT,
    });
  });

  posixIt("skips envelopes already at the keychain key-id on the next run", async () => {
    const roots = await fixture();
    const legacy = safeStorage();
    const keychain = await keychainEncryption();
    await seedCredential(roots.credentialRoot, "anthropic", "sk-anthropic", legacy.port);
    await seedProfile(roots, "synthetic-token", legacy.port);
    await migrateCredentialEnvelopes({ ...roots, legacy: legacy.port, keychain });
    const consulted = legacy.decryptCalls;

    await expect(
      migrateCredentialEnvelopes({ ...roots, legacy: legacy.port, keychain }),
    ).resolves.toEqual({
      status: "complete",
      migrated: 0,
      alreadyMigrated: 2,
      failed: 0,
      uncertain: 0,
    });
    expect(legacy.decryptCalls).toBe(consulted);
  });

  posixIt("resumes the unmigrated envelopes after a failed one", async () => {
    const roots = await fixture();
    const legacy = safeStorage();
    const keychain = await keychainEncryption();
    await seedCredential(roots.credentialRoot, "anthropic", "sk-anthropic", legacy.port);
    await seedCredential(roots.credentialRoot, "openrouter", "sk-openrouter", legacy.port);
    await seedProfile(roots, "synthetic-token", legacy.port);

    await expect(
      migrateCredentialEnvelopes({
        ...roots,
        legacy: legacy.port,
        keychain: refuseValue(keychain, "sk-openrouter"),
      }),
    ).resolves.toEqual({
      status: "incomplete",
      migrated: 2,
      alreadyMigrated: 0,
      failed: 1,
      uncertain: 0,
    });
    await expect(keyIdOf(join(roots.credentialRoot, "anthropic.bin"))).resolves.toBe(
      KEYCHAIN_ENVELOPE_KEY_ID,
    );
    await expect(keyIdOf(join(roots.credentialRoot, "openrouter.bin"))).resolves.toBe(
      SAFE_STORAGE_ENVELOPE_KEY_ID,
    );

    await expect(
      migrateCredentialEnvelopes({ ...roots, legacy: legacy.port, keychain }),
    ).resolves.toEqual({
      status: "complete",
      migrated: 1,
      alreadyMigrated: 2,
      failed: 0,
      uncertain: 0,
    });
    await expect(keyIdOf(join(roots.credentialRoot, "openrouter.bin"))).resolves.toBe(
      KEYCHAIN_ENVELOPE_KEY_ID,
    );
  });

  posixIt("keeps a failed envelope readable while the pass is incomplete", async () => {
    const roots = await fixture();
    const legacy = safeStorage();
    const keychain = await keychainEncryption();
    await seedCredential(roots.credentialRoot, "anthropic", "sk-anthropic", legacy.port);
    await seedCredential(roots.credentialRoot, "openrouter", "sk-openrouter", legacy.port);

    const outcome = await migrateCredentialEnvelopes({
      ...roots,
      legacy: legacy.port,
      keychain: refuseValue(keychain, "sk-openrouter"),
    });
    expect(outcome.status).toBe("incomplete");

    const vault = createCredentialVault({
      root: roots.credentialRoot,
      encryption: createLegacyReadFallbackEncryption({ keychain, legacy: legacy.port }),
      applyCredential: vi.fn(async () => undefined),
    });
    await expect(vault.credentialStatuses()).resolves.toEqual(
      expect.arrayContaining([
        { slot: "anthropic", state: "configured", runtimeState: "stored-inactive" },
        { slot: "openrouter", state: "configured", runtimeState: "stored-inactive" },
      ]),
    );
  });

  posixIt("leaves the envelope untouched when the durable replace refuses", async () => {
    const roots = await fixture();
    const legacy = safeStorage();
    await seedCredential(roots.credentialRoot, "anthropic", "sk-anthropic", legacy.port);
    const before = await readFile(join(roots.credentialRoot, "anthropic.bin"));

    await expect(
      migrateCredentialEnvelopes({
        ...roots,
        legacy: legacy.port,
        keychain: await keychainEncryption(),
        renameFile: (async () => {
          throw new TypeError("synthetic rename failure");
        }) as never,
      }),
    ).resolves.toEqual({
      status: "incomplete",
      migrated: 0,
      alreadyMigrated: 0,
      failed: 1,
      uncertain: 0,
    });
    await expect(readFile(join(roots.credentialRoot, "anthropic.bin"))).resolves.toEqual(before);
  });

  posixIt("refuses an envelope the safeStorage backend cannot decrypt", async () => {
    const roots = await fixture();
    const keychain = await keychainEncryption();
    await seedCredential(roots.credentialRoot, "anthropic", "sk-anthropic", safeStorage().port);
    const foreign: CredentialEncryptionPort = {
      isEncryptionAvailable: () => true,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => {
        throw new TypeError("synthetic decrypt failure");
      },
    };

    await expect(
      migrateCredentialEnvelopes({ ...roots, legacy: foreign, keychain }),
    ).resolves.toMatchObject({ status: "incomplete", failed: 1, migrated: 0 });
    await expect(keyIdOf(join(roots.credentialRoot, "anthropic.bin"))).resolves.toBe(
      SAFE_STORAGE_ENVELOPE_KEY_ID,
    );
  });

  posixIt("skips an envelope that disappeared before its turn", async () => {
    const roots = await fixture();
    const legacy = safeStorage();
    await seedCredential(roots.credentialRoot, "anthropic", "sk-anthropic", legacy.port);
    let reads = 0;

    await expect(
      migrateCredentialEnvelopes({
        ...roots,
        legacy: legacy.port,
        keychain: await keychainEncryption(),
        readEnvelopeFile: (async (path: string) => {
          reads += 1;
          if (reads > 1) throw Object.assign(new Error("missing"), { code: "ENOENT" });
          return await readFile(path);
        }) as never,
      }),
    ).resolves.toEqual({
      status: "complete",
      migrated: 0,
      alreadyMigrated: 0,
      failed: 0,
      uncertain: 0,
    });
  });
});

describe("legacy read fallback", () => {
  posixIt("reads both key-ids, writes only the keychain key-id", async () => {
    const legacy = safeStorage();
    const keychain = await keychainEncryption();
    const fallback = createLegacyReadFallbackEncryption({ keychain, legacy: legacy.port });

    const sealed = fallback.encryptString("sk-value");
    expect(credentialEnvelopeKeyId(sealed)).toBe(KEYCHAIN_ENVELOPE_KEY_ID);
    expect(fallback.decryptString(sealed)).toBe("sk-value");
    expect(fallback.decryptString(legacy.port.encryptString("sk-old"))).toBe("sk-old");
    expect(fallback.getSelectedStorageBackend?.()).toBe(KEYCHAIN_PARTITION_STORAGE_BACKEND);
    expect(fallback.isEncryptionAvailable()).toBe(true);
  });

  posixIt("stops reading through safeStorage once the pass is complete", async () => {
    const roots = await fixture();
    const legacy = safeStorage();
    const keychain = await keychainEncryption();
    await seedCredential(roots.credentialRoot, "anthropic", "sk-anthropic", legacy.port);
    await migrateCredentialEnvelopes({ ...roots, legacy: legacy.port, keychain });
    const consulted = legacy.decryptCalls;

    const vault = createCredentialVault({
      root: roots.credentialRoot,
      encryption: createLegacyReadFallbackEncryption({ keychain, legacy: legacy.port }),
      applyCredential: vi.fn(async () => undefined),
    });
    await expect(vault.credentialStatuses()).resolves.toEqual(
      expect.arrayContaining([
        { slot: "anthropic", state: "configured", runtimeState: "stored-inactive" },
      ]),
    );
    expect(legacy.decryptCalls).toBe(consulted);
  });
});

describe("migrated envelope permissions", () => {
  posixIt("keeps both vault file modes after migration", async () => {
    const roots = await fixture();
    const legacy = safeStorage();
    await seedCredential(roots.credentialRoot, "anthropic", "sk-anthropic", legacy.port);
    await seedProfile(roots, "synthetic-token", legacy.port);

    await migrateCredentialEnvelopes({
      ...roots,
      legacy: legacy.port,
      keychain: await keychainEncryption(),
    });

    for (const path of [
      join(roots.credentialRoot, "anthropic.bin"),
      join(roots.telegramRoot, TELEGRAM_PROFILE_FILE_NAME),
    ]) {
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
    }
  });
});
