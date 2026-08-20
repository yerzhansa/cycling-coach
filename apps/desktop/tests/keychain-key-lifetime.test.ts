import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCredentialVault,
  type CredentialEncryptionPort,
  type DesktopCredentialSlot,
} from "../src/main/credential-vault.js";
import { createKeychainPartitionEncryption } from "../src/main/keychain-credential-encryption.js";
import {
  KEYCHAIN_CREDENTIAL_SERVICE,
  KEYCHAIN_KEY_BYTES,
  KEYCHAIN_TEAM_IDENTIFIER,
  type KeychainHelperRequest,
  type KeychainHelperResponse,
  type KeychainHelperTransport,
} from "../src/main/keychain-helper.js";
import { retireKeychainKeyWhenLastEnvelopeGone } from "../src/main/keychain-key-lifetime.js";
import { createTelegramCredentialVault } from "../src/main/telegram-credential-vault.js";

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
  const base = await mkdtemp(join(await realpath(tmpdir()), "desktop-key-lifetime-"));
  fixtureRoots.push(base);
  const home = join(base, "athlete-home");
  await mkdir(home, { mode: 0o700 });
  return {
    credentialRoot: join(base, "credentials-v1"),
    telegramRoot: join(base, "telegram-channel-v1"),
    athleteHome: await realpath(home),
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

async function keychainEncryption(): Promise<CredentialEncryptionPort> {
  const result = await createKeychainPartitionEncryption({
    transport: transportOf(PROBE_OK, {
      ok: true,
      op: "read-key",
      key: randomBytes(KEYCHAIN_KEY_BYTES).toString("base64"),
    }),
    service: KEYCHAIN_CREDENTIAL_SERVICE,
  });
  if (result.status !== "ready") throw new TypeError();
  return result.encryption;
}

function credentialVault(roots: Fixture, encryption: CredentialEncryptionPort) {
  return createCredentialVault({
    root: roots.credentialRoot,
    encryption,
    applyCredential: vi.fn(async () => undefined),
    clearCredential: vi.fn(async () => "not-active" as const),
  });
}

function telegramVault(roots: Fixture, encryption: CredentialEncryptionPort) {
  return createTelegramCredentialVault({
    root: roots.telegramRoot,
    athleteHome: roots.athleteHome,
    encryption,
  });
}

async function seedCredential(
  roots: Fixture,
  slot: DesktopCredentialSlot,
  value: string,
  encryption: CredentialEncryptionPort,
): Promise<void> {
  await expect(
    credentialVault(roots, encryption).writeCredential({ slot, value }, { activate: false }),
  ).resolves.toMatchObject({ status: "configured" });
}

async function seedProfile(roots: Fixture, encryption: CredentialEncryptionPort): Promise<void> {
  await expect(
    telegramVault(roots, encryption).replaceProfile({
      token: "synthetic-token",
      bot: BOT,
      authenticatedAthleteHome: roots.athleteHome,
    }),
  ).resolves.toMatchObject({ outcome: "applied" });
}

afterEach(async () => {
  for (const root of fixtureRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("keychain key retirement", () => {
  posixIt("keeps the key while any envelope survives in either vault", async () => {
    const roots = await fixture();
    const encryption = await keychainEncryption();
    await seedCredential(roots, "anthropic", "sk-anthropic", encryption);
    await seedProfile(roots, encryption);
    const transport = transportOf();

    await expect(
      credentialVault(roots, encryption).deleteCredential("anthropic"),
    ).resolves.toMatchObject({ slot: "anthropic", status: "deleted" });

    await expect(
      retireKeychainKeyWhenLastEnvelopeGone({
        ...roots,
        transport,
        service: KEYCHAIN_CREDENTIAL_SERVICE,
      }),
    ).resolves.toEqual({ status: "retained", envelopes: 1 });
    expect(transport.requests).toHaveLength(0);
  });

  posixIt("deletes the key when the last envelope across both vaults is gone", async () => {
    const roots = await fixture();
    const encryption = await keychainEncryption();
    await seedCredential(roots, "anthropic", "sk-anthropic", encryption);
    await seedCredential(roots, "openrouter", "sk-openrouter", encryption);
    await seedProfile(roots, encryption);
    const transport = transportOf({ ok: true, op: "delete-key", deleted: true });

    for (const slot of ["anthropic", "openrouter"] as const) {
      await expect(
        credentialVault(roots, encryption).deleteCredential(slot),
      ).resolves.toMatchObject({ status: "deleted" });
    }
    await expect(
      retireKeychainKeyWhenLastEnvelopeGone({
        ...roots,
        transport,
        service: KEYCHAIN_CREDENTIAL_SERVICE,
      }),
    ).resolves.toMatchObject({ status: "retained" });

    await expect(telegramVault(roots, encryption).deleteProfile()).resolves.toMatchObject({
      outcome: "applied",
    });

    await expect(
      retireKeychainKeyWhenLastEnvelopeGone({
        ...roots,
        transport,
        service: KEYCHAIN_CREDENTIAL_SERVICE,
      }),
    ).resolves.toEqual({ status: "deleted" });
    expect(transport.requests).toEqual([
      { op: "delete-key", service: KEYCHAIN_CREDENTIAL_SERVICE },
    ]);
  });

  posixIt("keeps the key while an envelope exists but cannot be read", async () => {
    const roots = await fixture();
    const transport = transportOf();

    await expect(
      retireKeychainKeyWhenLastEnvelopeGone({
        ...roots,
        transport,
        service: KEYCHAIN_CREDENTIAL_SERVICE,
        readEnvelopeFile: (async () => {
          throw Object.assign(new Error("synthetic read failure"), { code: "EACCES" });
        }) as never,
      }),
    ).resolves.toMatchObject({ status: "retained" });
    expect(transport.requests).toHaveLength(0);
  });

  posixIt("reports an absent item and a refused delete apart", async () => {
    const roots = await fixture();

    await expect(
      retireKeychainKeyWhenLastEnvelopeGone({
        ...roots,
        transport: transportOf({ ok: true, op: "delete-key", deleted: false }),
        service: KEYCHAIN_CREDENTIAL_SERVICE,
      }),
    ).resolves.toEqual({ status: "already-absent" });

    await expect(
      retireKeychainKeyWhenLastEnvelopeGone({
        ...roots,
        transport: transportOf({ ok: false, code: "keychain-locked" }),
        service: KEYCHAIN_CREDENTIAL_SERVICE,
      }),
    ).resolves.toEqual({ status: "failed", code: "keychain-locked" });
  });
});
