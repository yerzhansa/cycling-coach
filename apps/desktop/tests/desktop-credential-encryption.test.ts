import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CredentialEncryptionPort } from "../src/main/credential-vault.js";
import {
  desktopKeychainCredentialService,
  prepareDesktopCredentialEncryption,
  type PrepareDesktopCredentialEncryptionOptions,
} from "../src/main/desktop-credential-encryption.js";
import {
  KEYCHAIN_PARTITION_STORAGE_BACKEND,
  sealCredentialEnvelope,
} from "../src/main/keychain-credential-encryption.js";
import {
  KEYCHAIN_CREDENTIAL_SERVICE,
  KEYCHAIN_CREDENTIAL_SERVICE_DEV,
  KEYCHAIN_KEY_BYTES,
  KEYCHAIN_TEAM_IDENTIFIER,
  type KeychainHelperRequest,
  type KeychainHelperResponse,
} from "../src/main/keychain-helper.js";

const CREDENTIAL_ROOT = "/synthetic/userData/credentials-v1";
const TELEGRAM_ROOT = "/synthetic/userData/telegram-channel-v1";
const KEY = randomBytes(KEYCHAIN_KEY_BYTES);
const PROBE_OK: KeychainHelperResponse = {
  ok: true,
  op: "probe",
  teamIdentifier: KEYCHAIN_TEAM_IDENTIFIER,
};

function safeStoragePort(): CredentialEncryptionPort {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) =>
      Buffer.concat([Buffer.from("SAFE:"), Buffer.from(value, "utf8")]),
    decryptString: (value: Buffer) => value.subarray(5).toString("utf8"),
    getSelectedStorageBackend: () => "basic_text",
  };
}

function transportOf(...answers: readonly KeychainHelperResponse[]) {
  const requests: KeychainHelperRequest[] = [];
  const queue = [...answers];
  return {
    requests,
    send: vi.fn(async (request: KeychainHelperRequest) => {
      requests.push(request);
      return queue.shift() ?? ({ ok: false, code: "unknown" } as KeychainHelperResponse);
    }),
  };
}

function noEnvelopes() {
  return (async () => {
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  }) as never;
}

function migratedTelegramEnvelope() {
  const sealed = sealCredentialEnvelope(KEY, "bot-token");
  return (async (path: string) => {
    if (path.startsWith(TELEGRAM_ROOT)) return sealed;
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  }) as never;
}

function options(
  overrides: Partial<PrepareDesktopCredentialEncryptionOptions> = {},
): PrepareDesktopCredentialEncryptionOptions {
  return {
    credentialRoot: CREDENTIAL_ROOT,
    telegramRoot: TELEGRAM_ROOT,
    safeStorage: safeStoragePort(),
    readEnvelopeFile: noEnvelopes(),
    location: {
      platform: "darwin",
      packaged: true,
      resourcesPath: "/Applications/Enduragent.app/Contents/Resources",
      applicationPath: "/Applications/Enduragent.app/Contents/Resources/app.asar",
    },
    helperIsExecutable: async () => true,
    ...overrides,
  };
}

describe("desktop credential encryption startup", () => {
  it("separates the signed-release service from the development service", () => {
    expect(desktopKeychainCredentialService(true)).toBe(KEYCHAIN_CREDENTIAL_SERVICE);
    expect(desktopKeychainCredentialService(false)).toBe(KEYCHAIN_CREDENTIAL_SERVICE_DEV);
    expect(KEYCHAIN_CREDENTIAL_SERVICE_DEV).not.toBe(KEYCHAIN_CREDENTIAL_SERVICE);
  });

  it("asks the packaged lane for the signed-release service exactly once per key acquisition", async () => {
    const transport = transportOf(PROBE_OK, { ok: true, op: "read-key", key: KEY.toString("base64") });

    const prepared = await prepareDesktopCredentialEncryption(
      options({ createTransport: () => transport }),
    );

    expect(prepared.service).toBe(KEYCHAIN_CREDENTIAL_SERVICE);
    expect(transport.requests.map((request) => request.op)).toEqual(["probe", "read-key"]);
    expect(
      transport.requests.every((request) => request.service === KEYCHAIN_CREDENTIAL_SERVICE),
    ).toBe(true);
    expect(prepared.selection.status).toBe("keychain");
    expect(prepared.encryption.getSelectedStorageBackend?.()).toBe(
      KEYCHAIN_PARTITION_STORAGE_BACKEND,
    );
  });

  it("never lets an unpackaged run touch the signed-release service", async () => {
    const transport = transportOf(PROBE_OK, { ok: true, op: "read-key", key: KEY.toString("base64") });

    const prepared = await prepareDesktopCredentialEncryption(
      options({
        createTransport: () => transport,
        location: {
          platform: "darwin",
          packaged: false,
          resourcesPath: "/opt/electron/resources",
          applicationPath: "/repository/apps/desktop",
        },
      }),
    );

    expect(prepared.service).toBe(KEYCHAIN_CREDENTIAL_SERVICE_DEV);
    expect(transport.requests).not.toHaveLength(0);
    for (const request of transport.requests) {
      expect(request.service).toBe(KEYCHAIN_CREDENTIAL_SERVICE_DEV);
      expect(request.service).not.toBe(KEYCHAIN_CREDENTIAL_SERVICE);
    }
  });

  it("resolves the development helper from the application path", async () => {
    const createTransport = vi.fn(() =>
      transportOf(PROBE_OK, { ok: true, op: "read-key", key: KEY.toString("base64") }),
    );

    await prepareDesktopCredentialEncryption(
      options({
        createTransport,
        location: {
          platform: "darwin",
          packaged: false,
          resourcesPath: "/opt/electron/resources",
          applicationPath: "/repository/apps/desktop",
        },
      }),
    );

    expect(createTransport).toHaveBeenCalledWith(
      "/repository/apps/desktop/dist/keychain-helper/keychain-helper",
    );
  });

  it("keeps Windows on the injected safeStorage port without resolving a helper", async () => {
    const safeStorage = safeStoragePort();
    const createTransport = vi.fn(() => transportOf());
    const helperIsExecutable = vi.fn(async () => true);

    const prepared = await prepareDesktopCredentialEncryption(
      options({
        safeStorage,
        createTransport,
        helperIsExecutable,
        location: {
          platform: "win32",
          packaged: true,
          resourcesPath: "C:/Program Files/Enduragent/resources",
          applicationPath: "C:/Program Files/Enduragent/resources/app.asar",
        },
      }),
    );

    expect(prepared.encryption).toBe(safeStorage);
    expect(prepared.selection.status).toBe("safe-storage");
    expect(createTransport).not.toHaveBeenCalled();
    expect(helperIsExecutable).not.toHaveBeenCalled();
    await expect(prepared.retireKeychainKey()).resolves.toBeUndefined();
  });

  it("falls back to safeStorage when the bundled helper cannot run and nothing is migrated", async () => {
    const safeStorage = safeStoragePort();
    const createTransport = vi.fn(() => transportOf());

    const prepared = await prepareDesktopCredentialEncryption(
      options({ safeStorage, createTransport, helperIsExecutable: async () => false }),
    );

    expect(prepared.encryption).toBe(safeStorage);
    expect(prepared.selection.status).toBe("safe-storage");
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("refuses instead of downgrading when a migrated envelope outlives the helper", async () => {
    const safeStorage = safeStoragePort();

    const prepared = await prepareDesktopCredentialEncryption(
      options({
        safeStorage,
        helperIsExecutable: async () => false,
        readEnvelopeFile: migratedTelegramEnvelope(),
      }),
    );

    expect(prepared.selection.status).toBe("refused");
    if (prepared.selection.status !== "refused") return;
    expect(prepared.selection.reason).toBe("encryption-unavailable");
    expect(prepared.encryption).not.toBe(safeStorage);
    expect(prepared.encryption.isEncryptionAvailable()).toBe(false);
    expect(() => prepared.encryption.encryptString("sk-anthropic")).toThrow();
  });

  it("refuses without a safeStorage downgrade when selection itself throws", async () => {
    const safeStorage = safeStoragePort();
    const createTransport = vi.fn(() => {
      throw new Error("synthetic transport failure");
    });

    const prepared = await prepareDesktopCredentialEncryption(
      options({ safeStorage, createTransport }),
    );

    expect(prepared.selection.status).toBe("refused");
    if (prepared.selection.status !== "refused") return;
    expect(prepared.selection.reason).toBe("storage-failed");
    expect(prepared.encryption).not.toBe(safeStorage);
    expect(prepared.encryption.getSelectedStorageBackend?.()).toBe(
      KEYCHAIN_PARTITION_STORAGE_BACKEND,
    );
  });

  it("retires the key only when the keychain backend is live and every envelope is gone", async () => {
    const transport = transportOf(
      PROBE_OK,
      { ok: true, op: "read-key", key: KEY.toString("base64") },
      { ok: true, op: "delete-key", deleted: true },
    );

    const prepared = await prepareDesktopCredentialEncryption(
      options({ createTransport: () => transport }),
    );

    await expect(prepared.retireKeychainKey()).resolves.toEqual({ status: "deleted" });
    expect(transport.requests.at(-1)).toEqual({
      op: "delete-key",
      service: KEYCHAIN_CREDENTIAL_SERVICE,
    });
  });

  it("keeps the key while any envelope survives in either vault", async () => {
    const transport = transportOf(PROBE_OK, { ok: true, op: "read-key", key: KEY.toString("base64") });

    const prepared = await prepareDesktopCredentialEncryption(
      options({
        createTransport: () => transport,
        readEnvelopeFile: migratedTelegramEnvelope(),
      }),
    );

    await expect(prepared.retireKeychainKey()).resolves.toEqual({
      status: "retained",
      envelopes: 1,
    });
    expect(transport.requests.some((request) => request.op === "delete-key")).toBe(false);
  });

  it("never deletes a keychain item from a refusing or safeStorage lane", async () => {
    const transport = transportOf({ ok: false, code: "keychain-locked" });

    const prepared = await prepareDesktopCredentialEncryption(
      options({
        createTransport: () => transport,
        readEnvelopeFile: migratedTelegramEnvelope(),
      }),
    );

    expect(prepared.selection.status).toBe("refused");
    await expect(prepared.retireKeychainKey()).resolves.toBeUndefined();
    expect(transport.requests.some((request) => request.op === "delete-key")).toBe(false);
  });
});

describe("desktop startup wiring", () => {
  it("selects the credential backend once, before either vault is constructed", async () => {
    const source = await readFile(resolve(import.meta.dirname, "../src/main/index.ts"), "utf8");

    const selection = source.indexOf("await prepareDesktopCredentialEncryption({");
    const telegramVault = source.indexOf("createTelegramCredentialVault({");
    const credentialVault = source.indexOf("createCredentialVault({");

    expect(selection).toBeGreaterThan(0);
    expect(source.split("prepareDesktopCredentialEncryption(")).toHaveLength(2);
    expect(selection).toBeLessThan(telegramVault);
    expect(selection).toBeLessThan(credentialVault);
  });

  it("injects the selected port into every vault and keeps safeStorage out of the vaults", async () => {
    const source = await readFile(resolve(import.meta.dirname, "../src/main/index.ts"), "utf8");

    expect(source).not.toMatch(/encryption: safeStorage/u);
    expect(source.split("encryption: credentialEncryption.encryption")).toHaveLength(4);
    expect(source).toMatch(/safeStorage,\n/u);
  });

  it("reports the selected backend on darwin only", async () => {
    const source = await readFile(resolve(import.meta.dirname, "../src/main/index.ts"), "utf8");
    const report = source.indexOf("desktop-credential-backend ");

    expect(report).toBeGreaterThan(0);
    expect(source.slice(report - 400, report)).toMatch(/process\.platform === "darwin"/u);
  });

  it("retires the keychain key from both envelope-deletion paths", async () => {
    const source = await readFile(resolve(import.meta.dirname, "../src/main/index.ts"), "utf8");

    expect(source).toMatch(/credentialEncryption\.retireKeychainKey\(\)/u);
    expect(
      source.split("observeEnvelopeRemoved: retireCredentialEncryptionKey"),
    ).toHaveLength(3);
  });
});
