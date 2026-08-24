import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAutomaticKeyRetirementInspector } from "../src/main/automatic-key-retirement.js";
import {
  CREDENTIAL_DIRECTORY_MODE,
  createCredentialVault,
  type CredentialEncryptionPort,
} from "../src/main/credential-vault.js";
import {
  createCredentialEnvelopeMutationLock,
  type CredentialEnvelopeLockProof,
} from "../src/main/credential-envelope-lock.js";
import {
  openCredentialEnvelope,
  sealCredentialEnvelope,
} from "../src/main/keychain-credential-encryption.js";
import { retireKeychainKeyWhenLastEnvelopeGone } from "../src/main/keychain-key-lifetime.js";
import { syncDirectory } from "../src/main/durable-atomic-replace.js";
import {
  KEYCHAIN_CREDENTIAL_SERVICE,
  KEYCHAIN_KEY_BYTES,
  type KeychainBindingRequest,
  type KeychainBindingResponse,
} from "../src/main/keychain-binding.js";
import {
  createTelegramCredentialVault,
  TELEGRAM_CREDENTIAL_DIRECTORY_MODE,
} from "../src/main/telegram-credential-vault.js";

const posixIt = it.skipIf(process.platform === "win32");
const BOT = { id: 987654, username: "synthetic_bot" } as const;
const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

interface Fixture {
  readonly credentialRoot: string;
  readonly telegramRoot: string;
  readonly athleteHome: string;
}

async function fixture(): Promise<Fixture> {
  const base = await mkdtemp(join(await realpath(tmpdir()), "desktop-key-retirement-"));
  fixtureRoots.push(base);
  const home = join(base, "athlete-home");
  await mkdir(home, { mode: 0o700 });
  return {
    credentialRoot: join(base, "credentials-v1"),
    telegramRoot: join(base, "telegram-channel-v1"),
    athleteHome: await realpath(home),
  };
}

function keychainPort(key: Buffer): CredentialEncryptionPort {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => sealCredentialEnvelope(key, value),
    decryptString: (envelope: Buffer) => openCredentialEnvelope(key, envelope),
    getSelectedStorageBackend: () => "keychain_partition_v1",
  };
}

function transportOf(...responses: readonly KeychainBindingResponse[]) {
  const remaining = [...responses];
  const requests: KeychainBindingRequest[] = [];
  return {
    requests,
    send(request: KeychainBindingRequest): Promise<KeychainBindingResponse> {
      requests.push(request);
      return Promise.resolve(remaining.shift() ?? { ok: false, code: "unknown" });
    },
  };
}

async function retireKey(
  roots: Fixture,
  transport: ReturnType<typeof transportOf>,
  lockProof: CredentialEnvelopeLockProof,
  synchronizeDirectory?: (root: string) => Promise<void>,
) {
  const inspect = createAutomaticKeyRetirementInspector(roots, process.platform, {
    syncDirectory: synchronizeDirectory,
  });
  return await retireKeychainKeyWhenLastEnvelopeGone({
    lockProof,
    retireKey: async (proof) => {
      const inspection = await inspect(proof);
      if (inspection.status === "failed") {
        return { status: "failed", code: "unknown", keyCleanupPending: false };
      }
      if (inspection.zeroProof === null) {
        return { status: "retained", envelopes: inspection.deletionBlockers };
      }
      const deleted = await transport.send({
        op: "delete-key",
        service: KEYCHAIN_CREDENTIAL_SERVICE,
      });
      if (!deleted.ok) {
        return { status: "failed", code: deleted.code, keyCleanupPending: true };
      }
      if (deleted.op !== "delete-key") {
        return { status: "failed", code: "unknown", keyCleanupPending: true };
      }
      return { status: deleted.deleted ? "deleted" : "already-absent" };
    },
  });
}

describe("keychain key retirement call sites", () => {
  posixIt("retires the key when deleting the last credential envelope", async () => {
    const roots = await fixture();
    const encryption = keychainPort(randomBytes(KEYCHAIN_KEY_BYTES));
    const transport = transportOf({ ok: true, op: "delete-key", deleted: true });
    const serializeEnvelopeMutation = createCredentialEnvelopeMutationLock();
    const observeEnvelopeRemoved = vi.fn(async (proof: CredentialEnvelopeLockProof) => {
      await retireKey(roots, transport, proof);
    });
    const vault = createCredentialVault({
      root: roots.credentialRoot,
      encryption,
      serializeEnvelopeMutation,
      revalidateEnvelopeRemoval: async () => true,
      observeEnvelopeRemoved,
      applyCredential: vi.fn(async () => undefined),
      clearCredential: vi.fn(async () => "cleared" as const),
    });
    await expect(
      vault.writeCredential({ slot: "anthropic", value: "sk-anthropic" }, { activate: false }),
    ).resolves.toMatchObject({ status: "configured" });

    await expect(vault.deleteCredential("anthropic")).resolves.toMatchObject({
      status: "deleted",
    });

    expect(observeEnvelopeRemoved).toHaveBeenCalledOnce();
    expect(transport.requests).toEqual([
      { op: "delete-key", service: KEYCHAIN_CREDENTIAL_SERVICE },
    ]);
  });

  posixIt("keeps the key when credential tombstone cleanup is not durable", async () => {
    const roots = await fixture();
    await mkdir(roots.telegramRoot, { mode: TELEGRAM_CREDENTIAL_DIRECTORY_MODE });
    const encryption = keychainPort(randomBytes(KEYCHAIN_KEY_BYTES));
    const transport = transportOf({ ok: true, op: "delete-key", deleted: true });
    const serializeEnvelopeMutation = createCredentialEnvelopeMutationLock();
    let deleting = false;
    let deletionSyncs = 0;
    const vault = createCredentialVault({
      root: roots.credentialRoot,
      encryption,
      serializeEnvelopeMutation,
      revalidateEnvelopeRemoval: async () => true,
      observeEnvelopeRemoved: async (proof) => {
        await retireKey(roots, transport, proof, async () => {
          expect(
            (await readdir(roots.credentialRoot)).some((entry) => entry.endsWith(".deleted")),
          ).toBe(false);
          throw new TypeError("synthetic retirement durability failure");
        });
      },
      syncCredentialDirectory: async (root) => {
        if (deleting) {
          deletionSyncs += 1;
          if (deletionSyncs === 2) throw new TypeError("synthetic final sync failure");
        }
        await syncDirectory(root);
      },
      applyCredential: vi.fn(async () => undefined),
      clearCredential: vi.fn(async () => "cleared" as const),
    });
    await vault.writeCredential(
      { slot: "anthropic", value: "sk-anthropic" },
      { activate: false },
    );

    deleting = true;
    await expect(vault.deleteCredential("anthropic")).resolves.toEqual({
      slot: "anthropic",
      status: "deleted",
      cleanupPending: true,
    });

    expect(deletionSyncs).toBe(2);
    expect(transport.requests).toEqual([]);
  });

  posixIt("keeps the key while another credential envelope survives", async () => {
    const roots = await fixture();
    const encryption = keychainPort(randomBytes(KEYCHAIN_KEY_BYTES));
    const transport = transportOf();
    const serializeEnvelopeMutation = createCredentialEnvelopeMutationLock();
    const vault = createCredentialVault({
      root: roots.credentialRoot,
      encryption,
      serializeEnvelopeMutation,
      revalidateEnvelopeRemoval: async () => true,
      observeEnvelopeRemoved: async (proof) => {
        await retireKey(roots, transport, proof);
      },
      applyCredential: vi.fn(async () => undefined),
      clearCredential: vi.fn(async () => "cleared" as const),
    });
    for (const slot of ["anthropic", "openai"] as const) {
      await expect(
        vault.writeCredential({ slot, value: `sk-${slot}` }, { activate: false }),
      ).resolves.toMatchObject({ status: "configured" });
    }

    await expect(vault.deleteCredential("anthropic")).resolves.toMatchObject({
      status: "deleted",
    });

    expect(transport.requests).toEqual([]);
  });

  posixIt("retires the key when removing the Telegram profile envelope", async () => {
    const roots = await fixture();
    const encryption = keychainPort(randomBytes(KEYCHAIN_KEY_BYTES));
    const transport = transportOf({ ok: true, op: "delete-key", deleted: true });
    const serializeEnvelopeMutation = createCredentialEnvelopeMutationLock();
    const observeEnvelopeRemoved = vi.fn(async (proof: CredentialEnvelopeLockProof) => {
      await retireKey(roots, transport, proof);
    });
    const vault = createTelegramCredentialVault({
      root: roots.telegramRoot,
      athleteHome: roots.athleteHome,
      encryption,
      serializeEnvelopeMutation,
      revalidateEnvelopeRemoval: async () => true,
      observeEnvelopeRemoved,
    });
    await expect(
      vault.replaceProfile({
        token: "123:synthetic",
        bot: BOT,
        authenticatedAthleteHome: roots.athleteHome,
      }),
    ).resolves.toMatchObject({ outcome: "applied" });

    await expect(vault.deleteProfile()).resolves.toMatchObject({ outcome: "applied" });

    expect(observeEnvelopeRemoved).toHaveBeenCalledOnce();
    expect(transport.requests).toEqual([
      { op: "delete-key", service: KEYCHAIN_CREDENTIAL_SERVICE },
    ]);
  });

  posixIt("keeps the key when Telegram tombstone cleanup is not durable", async () => {
    const roots = await fixture();
    await mkdir(roots.credentialRoot, { mode: CREDENTIAL_DIRECTORY_MODE });
    const encryption = keychainPort(randomBytes(KEYCHAIN_KEY_BYTES));
    const transport = transportOf({ ok: true, op: "delete-key", deleted: true });
    const serializeEnvelopeMutation = createCredentialEnvelopeMutationLock();
    let deleting = false;
    let deletionSyncs = 0;
    const vault = createTelegramCredentialVault({
      root: roots.telegramRoot,
      athleteHome: roots.athleteHome,
      encryption,
      serializeEnvelopeMutation,
      revalidateEnvelopeRemoval: async () => true,
      observeEnvelopeRemoved: async (proof) => {
        await retireKey(roots, transport, proof, async () => {
          expect(
            (await readdir(roots.telegramRoot)).some((entry) => entry.endsWith(".deleted")),
          ).toBe(false);
          throw new TypeError("synthetic retirement durability failure");
        });
      },
      syncDirectory: async (root) => {
        if (deleting) {
          deletionSyncs += 1;
          if (deletionSyncs === 2) throw new TypeError("synthetic final sync failure");
        }
        await syncDirectory(root);
      },
    });
    await vault.replaceProfile({
      token: "123:synthetic",
      bot: BOT,
      authenticatedAthleteHome: roots.athleteHome,
    });

    deleting = true;
    await expect(vault.deleteProfile()).resolves.toEqual({
      outcome: "applied",
      cleanupPending: true,
    });

    expect(deletionSyncs).toBe(2);
    expect(transport.requests).toEqual([]);
  });

  posixIt("creates a zero proof only after syncing both existing vault roots", async () => {
    const roots = await fixture();
    await mkdir(roots.credentialRoot, { mode: CREDENTIAL_DIRECTORY_MODE });
    await mkdir(roots.telegramRoot, { mode: TELEGRAM_CREDENTIAL_DIRECTORY_MODE });
    const events: string[] = [];
    const inspector = createAutomaticKeyRetirementInspector(
      {
        ...roots,
        readEnvelopeDirectory: async (root) => {
          events.push(`scan:${root}`);
          return [];
        },
      },
      process.platform,
      {
        syncDirectory: async (root) => {
          events.push(`sync:${root}`);
          await syncDirectory(root);
        },
      },
    );
    const serializeEnvelopeMutation = createCredentialEnvelopeMutationLock();

    const result = await serializeEnvelopeMutation((proof) => inspector(proof));

    expect(result.status).toBe("inspected");
    if (result.status !== "inspected") throw new TypeError();
    expect(result.zeroProof).not.toBeNull();
    expect(events.slice(0, 2)).toEqual([
      `sync:${roots.credentialRoot}`,
      `sync:${roots.telegramRoot}`,
    ]);
    expect(events.slice(2)).toEqual([
      `scan:${roots.credentialRoot}`,
      `scan:${roots.telegramRoot}`,
    ]);
  });

  posixIt("never creates a zero proof while an unexplained vault entry remains", async () => {
    const roots = await fixture();
    await mkdir(roots.credentialRoot, { mode: CREDENTIAL_DIRECTORY_MODE });
    await writeFile(join(roots.credentialRoot, "future-entry"), "unexplained");
    const transport = transportOf();
    const serializeEnvelopeMutation = createCredentialEnvelopeMutationLock();

    const result = await serializeEnvelopeMutation((proof) =>
      retireKey(roots, transport, proof),
    );

    expect(result).toEqual({ status: "retained", envelopes: 1 });
    expect(transport.requests).toEqual([]);
  });

  posixIt("keeps the key when a credential envelope outlives the Telegram profile", async () => {
    const roots = await fixture();
    const encryption = keychainPort(randomBytes(KEYCHAIN_KEY_BYTES));
    const transport = transportOf();
    const serializeEnvelopeMutation = createCredentialEnvelopeMutationLock();
    const credentials = createCredentialVault({
      root: roots.credentialRoot,
      encryption,
      serializeEnvelopeMutation,
      applyCredential: vi.fn(async () => undefined),
    });
    await expect(
      credentials.writeCredential(
        { slot: "anthropic", value: "sk-anthropic" },
        { activate: false },
      ),
    ).resolves.toMatchObject({ status: "configured" });
    const vault = createTelegramCredentialVault({
      root: roots.telegramRoot,
      athleteHome: roots.athleteHome,
      encryption,
      serializeEnvelopeMutation,
      revalidateEnvelopeRemoval: async () => true,
      observeEnvelopeRemoved: async (proof) => {
        await retireKey(roots, transport, proof);
      },
    });
    await expect(
      vault.replaceProfile({
        token: "123:synthetic",
        bot: BOT,
        authenticatedAthleteHome: roots.athleteHome,
      }),
    ).resolves.toMatchObject({ outcome: "applied" });

    await expect(vault.deleteProfile()).resolves.toMatchObject({ outcome: "applied" });

    expect(transport.requests).toEqual([]);
  });

  posixIt("never fails a deletion because retirement threw", async () => {
    const roots = await fixture();
    const encryption = keychainPort(randomBytes(KEYCHAIN_KEY_BYTES));
    const serializeEnvelopeMutation = createCredentialEnvelopeMutationLock();
    const vault = createCredentialVault({
      root: roots.credentialRoot,
      encryption,
      serializeEnvelopeMutation,
      revalidateEnvelopeRemoval: async () => true,
      observeEnvelopeRemoved: async () => {
        throw new Error("synthetic retirement failure");
      },
      applyCredential: vi.fn(async () => undefined),
      clearCredential: vi.fn(async () => "cleared" as const),
    });
    await expect(
      vault.writeCredential({ slot: "anthropic", value: "sk-anthropic" }, { activate: false }),
    ).resolves.toMatchObject({ status: "configured" });

    await expect(vault.deleteCredential("anthropic")).resolves.toMatchObject({
      status: "deleted",
    });
  });

  posixIt("blocks a write in the other vault through the zero-envelope census", async () => {
    const roots = await fixture();
    const key = randomBytes(KEYCHAIN_KEY_BYTES);
    const baseEncryption = keychainPort(key);
    let seals = 0;
    const encryption: CredentialEncryptionPort = {
      ...baseEncryption,
      encryptString(value) {
        seals += 1;
        return baseEncryption.encryptString(value);
      },
    };
    const serializeEnvelopeMutation = createCredentialEnvelopeMutationLock();
    const transport = transportOf({ ok: true, op: "delete-key", deleted: true });
    let releaseRetirement: (() => void) | undefined;
    let markRetirementStarted: (() => void) | undefined;
    const retirementBlocked = new Promise<void>((resolve) => {
      releaseRetirement = resolve;
    });
    const retirementStarted = new Promise<void>((resolve) => {
      markRetirementStarted = resolve;
    });
    const credentials = createCredentialVault({
      root: roots.credentialRoot,
      encryption,
      serializeEnvelopeMutation,
      revalidateEnvelopeRemoval: async () => true,
      observeEnvelopeRemoved: async (proof) => {
        markRetirementStarted?.();
        await retirementBlocked;
        await retireKey(roots, transport, proof);
      },
      applyCredential: vi.fn(async () => undefined),
      clearCredential: vi.fn(async () => "cleared" as const),
    });
    const telegram = createTelegramCredentialVault({
      root: roots.telegramRoot,
      athleteHome: roots.athleteHome,
      encryption,
      serializeEnvelopeMutation,
    });
    await credentials.writeCredential(
      { slot: "anthropic", value: "sk-anthropic" },
      { activate: false },
    );
    seals = 0;

    const deletion = credentials.deleteCredential("anthropic");
    await retirementStarted;
    const write = telegram.replaceProfile({
      token: "123:synthetic",
      bot: BOT,
      authenticatedAthleteHome: roots.athleteHome,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(seals).toBe(0);
    releaseRetirement?.();
    await expect(deletion).resolves.toMatchObject({ status: "deleted" });
    await expect(write).resolves.toMatchObject({ outcome: "applied" });
    expect(seals).toBe(1);
  });
});
