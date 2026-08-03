import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialEncryptionPort } from "../src/main/credential-vault.js";
import {
  TELEGRAM_BOT_METADATA_FILE_NAME,
  TELEGRAM_CREDENTIAL_DIRECTORY_MODE,
  TELEGRAM_CREDENTIAL_FILE_MODE,
  TELEGRAM_CREDENTIAL_FILE_NAME,
  TELEGRAM_DESIRED_STATE_FILE_NAME,
  createTelegramCredentialVault,
} from "../src/main/telegram-credential-vault.js";

const fixtureRoots: string[] = [];

interface VaultFixture {
  readonly root: string;
  readonly athleteHome: string;
}

async function fixture(): Promise<VaultFixture> {
  const base = await mkdtemp(join(await realpath(tmpdir()), "desktop-telegram-vault-"));
  fixtureRoots.push(base);
  const athleteHomePath = join(base, "athlete-home");
  await mkdir(athleteHomePath, { mode: 0o700 });
  return {
    root: join(base, "telegram-channel-v1"),
    athleteHome: await realpath(athleteHomePath),
  };
}

async function anotherHome(root: string): Promise<string> {
  const path = join(root, "..", "other-athlete-home");
  await mkdir(path, { mode: 0o700 });
  return realpath(path);
}

function encryption(): CredentialEncryptionPort {
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      return Buffer.concat([
        Buffer.from("SAFE:"),
        Buffer.from(value, "utf8").reverse(),
        Buffer.from(":END"),
      ]);
    },
    decryptString(value) {
      if (
        !value.subarray(0, 5).equals(Buffer.from("SAFE:")) ||
        !value.subarray(-4).equals(Buffer.from(":END"))
      ) {
        throw new TypeError();
      }
      return Buffer.from(value.subarray(5, -4)).reverse().toString("utf8");
    },
  };
}

async function writeEncryptedRecord(
  root: string,
  encryptionPort: CredentialEncryptionPort,
  value: unknown,
): Promise<void> {
  await mkdir(root, { recursive: true, mode: TELEGRAM_CREDENTIAL_DIRECTORY_MODE });
  await writeFile(
    join(root, TELEGRAM_CREDENTIAL_FILE_NAME),
    encryptionPort.encryptString(JSON.stringify(value)),
    { mode: TELEGRAM_CREDENTIAL_FILE_MODE },
  );
}

async function syncDirectory(root: string): Promise<void> {
  const handle = await open(root, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Telegram credential vault", () => {
  it("reports a missing credential without consulting the encryption backend", async () => {
    const value = await fixture();
    const isEncryptionAvailable = vi.fn(() => {
      throw new TypeError("encryption backend must stay idle");
    });
    const vault = createTelegramCredentialVault({
      ...value,
      encryption: {
        isEncryptionAvailable,
        encryptString: vi.fn(),
        decryptString: vi.fn(),
      },
    });

    await expect(vault.credentialStatus()).resolves.toEqual({ state: "missing" });
    expect(isEncryptionAvailable).not.toHaveBeenCalled();
  });

  it("refuses invalid input, a wrong authenticated home, and unsafe encryption before filesystem work", async () => {
    const value = await fixture();
    const otherHome = await anotherHome(value.root);
    const encryptString = vi.fn(() => Buffer.from("unused"));
    const unavailable = createTelegramCredentialVault({
      ...value,
      encryption: {
        isEncryptionAvailable: () => false,
        encryptString,
        decryptString: vi.fn(),
      },
    });

    await expect(
      unavailable.writeCredential({
        token: "synthetic-telegram-token",
        authenticatedAthleteHome: otherHome,
      }),
    ).resolves.toEqual({ status: "refused", reason: "wrong-home" });
    await expect(
      unavailable.writeCredential({
        token: " synthetic-telegram-token ",
        authenticatedAthleteHome: value.athleteHome,
      }),
    ).resolves.toEqual({ status: "refused", reason: "invalid-input" });
    await expect(
      unavailable.writeCredential({
        token: "synthetic-telegram-token",
        authenticatedAthleteHome: value.athleteHome,
      }),
    ).resolves.toEqual({ status: "refused", reason: "encryption-unavailable" });
    expect(encryptString).not.toHaveBeenCalled();
    await expect(lstat(value.root)).rejects.toMatchObject({ code: "ENOENT" });

    const unsafe = createTelegramCredentialVault({
      ...value,
      encryption: {
        ...encryption(),
        getSelectedStorageBackend: () => "basic_text",
      },
    });
    await expect(
      unsafe.writeCredential({
        token: "synthetic-telegram-token",
        authenticatedAthleteHome: value.athleteHome,
      }),
    ).resolves.toEqual({ status: "refused", reason: "unsafe-backend" });
  });

  it("writes one exact home-bound envelope as owner-only ciphertext and returns no token", async () => {
    const value = await fixture();
    const token = "synthetic-telegram-token";
    const baseEncryption = encryption();
    let encryptedBuffer: Buffer | undefined;
    let plaintext = "";
    const encryptionPort: CredentialEncryptionPort = {
      ...baseEncryption,
      encryptString(input) {
        plaintext = input;
        encryptedBuffer = baseEncryption.encryptString(input);
        return encryptedBuffer;
      },
    };
    const vault = createTelegramCredentialVault({ ...value, encryption: encryptionPort });

    const result = await vault.writeCredential({
      token,
      authenticatedAthleteHome: value.athleteHome,
    });

    expect(result).toEqual({ status: "configured" });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.parse(plaintext)).toEqual({
      schemaVersion: 1,
      athleteHome: value.athleteHome,
      token,
    });
    expect(encryptedBuffer?.every((byte) => byte === 0)).toBe(true);
    expect((await lstat(value.root)).mode & 0o777).toBe(TELEGRAM_CREDENTIAL_DIRECTORY_MODE);
    const credentialPath = join(value.root, TELEGRAM_CREDENTIAL_FILE_NAME);
    expect((await lstat(credentialPath)).mode & 0o777).toBe(TELEGRAM_CREDENTIAL_FILE_MODE);
    const ciphertext = await readFile(credentialPath);
    expect(ciphertext.includes(Buffer.from(token))).toBe(false);
    expect(await readdir(value.root)).toEqual([TELEGRAM_CREDENTIAL_FILE_NAME]);
    await expect(vault.credentialStatus()).resolves.toEqual({ state: "configured" });
    await expect(vault.desiredState()).resolves.toEqual({ state: "missing", enabled: false });
  });

  it("stores strict home-bound bot metadata separately as owner-only plaintext", async () => {
    const value = await fixture();
    const token = "synthetic-telegram-token";
    const username = "synthetic_bot";
    const baseEncryption = encryption();
    let encryptedPlaintext = "";
    const encryptString = vi.fn((input: string) => {
      encryptedPlaintext = input;
      return baseEncryption.encryptString(input);
    });
    const vault = createTelegramCredentialVault({
      ...value,
      encryption: { ...baseEncryption, encryptString },
    });

    await vault.writeCredential({
      token,
      authenticatedAthleteHome: value.athleteHome,
    });
    await expect(
      vault.writeBotMetadata({
        username,
        authenticatedAthleteHome: value.athleteHome,
      }),
    ).resolves.toEqual({ status: "stored", username });

    await expect(vault.botMetadata()).resolves.toEqual({ state: "configured", username });
    const metadataPath = join(value.root, TELEGRAM_BOT_METADATA_FILE_NAME);
    expect((await lstat(metadataPath)).mode & 0o777).toBe(TELEGRAM_CREDENTIAL_FILE_MODE);
    expect(JSON.parse(await readFile(metadataPath, "utf8"))).toEqual({
      schemaVersion: 1,
      athleteHome: value.athleteHome,
      username,
    });
    expect(JSON.parse(encryptedPlaintext)).toEqual({
      schemaVersion: 1,
      athleteHome: value.athleteHome,
      token,
    });
    expect(encryptedPlaintext).not.toContain(username);
    expect(encryptString).toHaveBeenCalledTimes(1);
  });

  it("validates bot metadata input before I/O and fails closed on foreign or malformed records", async () => {
    const value = await fixture();
    const otherHome = await anotherHome(value.root);
    const vault = createTelegramCredentialVault({ ...value, encryption: encryption() });

    await expect(
      vault.writeBotMetadata({
        username: "bad" as never,
        authenticatedAthleteHome: value.athleteHome,
      }),
    ).resolves.toEqual({ status: "refused", reason: "invalid-input" });
    await expect(
      vault.writeBotMetadata({
        username: "synthetic_bot",
        authenticatedAthleteHome: otherHome,
      }),
    ).resolves.toEqual({ status: "refused", reason: "wrong-home" });
    await expect(lstat(value.root)).rejects.toMatchObject({ code: "ENOENT" });

    await mkdir(value.root, { mode: TELEGRAM_CREDENTIAL_DIRECTORY_MODE });
    await vault.writeCredential({
      token: "synthetic-telegram-token",
      authenticatedAthleteHome: value.athleteHome,
    });
    const metadataPath = join(value.root, TELEGRAM_BOT_METADATA_FILE_NAME);
    await writeFile(
      metadataPath,
      `${JSON.stringify({ schemaVersion: 1, athleteHome: otherHome, username: "foreign_bot" })}\n`,
      { mode: TELEGRAM_CREDENTIAL_FILE_MODE },
    );
    await expect(vault.botMetadata()).resolves.toEqual({ state: "wrong-home" });
    await expect(
      vault.writeBotMetadata({
        username: "synthetic_bot",
        authenticatedAthleteHome: value.athleteHome,
      }),
    ).resolves.toEqual({ status: "refused", reason: "wrong-home" });
    await expect(vault.deleteBotMetadata()).resolves.toEqual({
      status: "refused",
      reason: "wrong-home",
    });
    await expect(vault.deleteCredential()).resolves.toEqual({
      status: "refused",
      reason: "wrong-home",
    });
    await expect(vault.credentialStatus()).resolves.toEqual({ state: "configured" });

    const malformedRecords = [
      {
        schemaVersion: 1,
        athleteHome: value.athleteHome,
        username: "synthetic_bot",
        extra: true,
      },
      { schemaVersion: 1, athleteHome: value.athleteHome, username: "bad" },
      { schemaVersion: 2, athleteHome: value.athleteHome, username: "synthetic_bot" },
    ];
    for (const record of malformedRecords) {
      await writeFile(metadataPath, `${JSON.stringify(record)}\n`, {
        mode: TELEGRAM_CREDENTIAL_FILE_MODE,
      });
      await expect(vault.botMetadata()).resolves.toEqual({ state: "re-prompt" });
    }
    await expect(
      vault.writeBotMetadata({
        username: "synthetic_bot",
        authenticatedAthleteHome: value.athleteHome,
      }),
    ).resolves.toEqual({ status: "refused", reason: "storage-failed" });
    await expect(vault.deleteBotMetadata()).resolves.toEqual({
      status: "refused",
      reason: "storage-failed",
    });
    await expect(vault.deleteCredential()).resolves.toEqual({
      status: "refused",
      reason: "storage-failed",
    });
    await expect(vault.credentialStatus()).resolves.toEqual({ state: "configured" });
  });

  it("deletes bot metadata independently without touching the encrypted credential", async () => {
    const value = await fixture();
    const vault = createTelegramCredentialVault({ ...value, encryption: encryption() });
    await vault.writeCredential({
      token: "synthetic-telegram-token",
      authenticatedAthleteHome: value.athleteHome,
    });
    await vault.writeBotMetadata({
      username: "synthetic_bot",
      authenticatedAthleteHome: value.athleteHome,
    });

    await expect(vault.deleteBotMetadata()).resolves.toEqual({
      status: "deleted",
      cleanupPending: false,
    });
    await expect(vault.botMetadata()).resolves.toEqual({ state: "missing" });
    await expect(vault.credentialStatus()).resolves.toEqual({ state: "configured" });
  });

  it("checks selected, encrypted-record, and authenticated homes before one-way application", async () => {
    const value = await fixture();
    const token = "synthetic-telegram-token";
    const otherHome = await anotherHome(value.root);
    const baseEncryption = encryption();
    const decryptString = vi.fn(baseEncryption.decryptString);
    const encryptionPort = { ...baseEncryption, decryptString };
    const vault = createTelegramCredentialVault({ ...value, encryption: encryptionPort });
    await vault.writeCredential({ token, authenticatedAthleteHome: value.athleteHome });
    const applyCredential = vi.fn(async () => {});

    await expect(vault.applyStoredCredential(otherHome, applyCredential)).resolves.toEqual({
      status: "refused",
      reason: "wrong-home",
    });
    expect(decryptString).not.toHaveBeenCalled();
    expect(applyCredential).not.toHaveBeenCalled();

    const alias = join(value.root, "..", "athlete-home-alias");
    await symlink(value.athleteHome, alias, "dir");
    await expect(
      vault.applyStoredCredential(await realpath(alias), applyCredential),
    ).resolves.toEqual({ status: "applied" });
    expect(applyCredential).toHaveBeenCalledExactlyOnceWith(token);

    const wrongHomeVault = createTelegramCredentialVault({
      root: value.root,
      athleteHome: otherHome,
      encryption: encryptionPort,
    });
    await expect(wrongHomeVault.credentialStatus()).resolves.toEqual({ state: "wrong-home" });
    await expect(wrongHomeVault.applyStoredCredential(otherHome, applyCredential)).resolves.toEqual(
      { status: "refused", reason: "wrong-home" },
    );
    await expect(wrongHomeVault.deleteCredential()).resolves.toEqual({
      status: "refused",
      reason: "wrong-home",
    });
    expect((await lstat(join(value.root, TELEGRAM_CREDENTIAL_FILE_NAME))).isFile()).toBe(true);
  });

  it("rejects malformed, noncanonical, and non-contract credential records without applying them", async () => {
    const value = await fixture();
    const encryptionPort = encryption();
    const vault = createTelegramCredentialVault({ ...value, encryption: encryptionPort });
    const invalidRecords = [
      {
        schemaVersion: 1,
        athleteHome: value.athleteHome,
        token: "synthetic-telegram-token",
        extra: true,
      },
      { schemaVersion: 2, athleteHome: value.athleteHome, token: "synthetic-telegram-token" },
      { schemaVersion: 1, athleteHome: "relative/home", token: "synthetic-telegram-token" },
      { schemaVersion: 1, athleteHome: value.athleteHome, token: " token-with-whitespace " },
      { schemaVersion: 1, athleteHome: value.athleteHome, token: "token\nwith-control" },
      { schemaVersion: 1, athleteHome: value.athleteHome, token: "x".repeat(513) },
    ];

    for (const record of invalidRecords) {
      await writeEncryptedRecord(value.root, encryptionPort, record);
      await expect(vault.credentialStatus()).resolves.toEqual({ state: "re-prompt" });
    }
    await writeFile(
      join(value.root, TELEGRAM_CREDENTIAL_FILE_NAME),
      Buffer.from("not-ciphertext"),
      {
        mode: TELEGRAM_CREDENTIAL_FILE_MODE,
      },
    );
    const applyCredential = vi.fn(async () => {});
    await expect(vault.applyStoredCredential(value.athleteHome, applyCredential)).resolves.toEqual({
      status: "refused",
      reason: "re-prompt",
    });
    expect(applyCredential).not.toHaveBeenCalled();
  });

  it("stores desired state separately, binds it to home identity, and never invokes encryption", async () => {
    const value = await fixture();
    const otherHome = await anotherHome(value.root);
    const encryptionPort = encryption();
    const encryptString = vi.fn(encryptionPort.encryptString);
    const decryptString = vi.fn(encryptionPort.decryptString);
    const vault = createTelegramCredentialVault({
      ...value,
      encryption: { ...encryptionPort, encryptString, decryptString },
    });

    await expect(vault.setDesiredState(true)).resolves.toEqual({ status: "stored", enabled: true });
    await expect(vault.desiredState()).resolves.toEqual({ state: "configured", enabled: true });
    await expect(vault.credentialStatus()).resolves.toEqual({ state: "missing" });
    expect(encryptString).not.toHaveBeenCalled();
    expect(decryptString).not.toHaveBeenCalled();
    const metadataPath = join(value.root, TELEGRAM_DESIRED_STATE_FILE_NAME);
    expect((await lstat(metadataPath)).mode & 0o777).toBe(TELEGRAM_CREDENTIAL_FILE_MODE);
    expect(JSON.parse(await readFile(metadataPath, "utf8"))).toEqual({
      schemaVersion: 1,
      athleteHome: value.athleteHome,
      enabled: true,
    });

    const otherVault = createTelegramCredentialVault({
      root: value.root,
      athleteHome: otherHome,
      encryption: encryptionPort,
    });
    await expect(otherVault.desiredState()).resolves.toEqual({
      state: "wrong-home",
      enabled: false,
    });
    await expect(otherVault.setDesiredState(false)).resolves.toEqual({
      status: "stored",
      enabled: false,
    });
    await expect(otherVault.desiredState()).resolves.toEqual({
      state: "configured",
      enabled: false,
    });
    await expect(vault.desiredState()).resolves.toEqual({ state: "wrong-home", enabled: false });
  });

  it("refuses symlinked or incorrectly permissioned directories and files", async () => {
    const value = await fixture();
    const actualRoot = join(value.root, "..", "actual-vault");
    await mkdir(actualRoot, { mode: TELEGRAM_CREDENTIAL_DIRECTORY_MODE });
    await symlink(actualRoot, value.root, "dir");
    const symlinkedRootVault = createTelegramCredentialVault({
      ...value,
      encryption: encryption(),
    });
    await expect(
      symlinkedRootVault.writeCredential({
        token: "synthetic-telegram-token",
        authenticatedAthleteHome: value.athleteHome,
      }),
    ).resolves.toEqual({ status: "refused", reason: "storage-failed" });
    await expect(symlinkedRootVault.setDesiredState(true)).resolves.toEqual({
      status: "refused",
      reason: "storage-failed",
    });

    const second = await fixture();
    await mkdir(second.root, { mode: TELEGRAM_CREDENTIAL_DIRECTORY_MODE });
    const outside = join(second.root, "..", "outside-secret");
    await writeFile(outside, "outside", { mode: TELEGRAM_CREDENTIAL_FILE_MODE });
    await symlink(outside, join(second.root, TELEGRAM_CREDENTIAL_FILE_NAME));
    const symlinkedFileVault = createTelegramCredentialVault({
      ...second,
      encryption: encryption(),
    });
    await expect(
      symlinkedFileVault.writeCredential({
        token: "synthetic-telegram-token",
        authenticatedAthleteHome: second.athleteHome,
      }),
    ).resolves.toEqual({ status: "refused", reason: "storage-failed" });
    expect(await readFile(outside, "utf8")).toBe("outside");

    await rm(join(second.root, TELEGRAM_CREDENTIAL_FILE_NAME));
    const outsideMetadata = join(second.root, "..", "outside-metadata");
    await writeFile(outsideMetadata, "outside", { mode: TELEGRAM_CREDENTIAL_FILE_MODE });
    await symlink(outsideMetadata, join(second.root, TELEGRAM_BOT_METADATA_FILE_NAME));
    await expect(symlinkedFileVault.botMetadata()).resolves.toEqual({ state: "re-prompt" });
    await expect(
      symlinkedFileVault.writeBotMetadata({
        username: "synthetic_bot",
        authenticatedAthleteHome: second.athleteHome,
      }),
    ).resolves.toEqual({ status: "refused", reason: "storage-failed" });
    await expect(symlinkedFileVault.deleteBotMetadata()).resolves.toEqual({
      status: "refused",
      reason: "storage-failed",
    });
    expect(await readFile(outsideMetadata, "utf8")).toBe("outside");

    await rm(join(second.root, TELEGRAM_BOT_METADATA_FILE_NAME));
    await chmod(second.root, 0o755);
    await expect(symlinkedFileVault.credentialStatus()).resolves.toEqual({ state: "re-prompt" });
    await expect(symlinkedFileVault.setDesiredState(true)).resolves.toEqual({
      status: "refused",
      reason: "storage-failed",
    });
  });

  it("cleans failed atomic writes and zeroes the produced ciphertext buffer", async () => {
    const value = await fixture();
    const baseEncryption = encryption();
    let encryptedBuffer: Buffer | undefined;
    const vault = createTelegramCredentialVault({
      ...value,
      encryption: {
        ...baseEncryption,
        encryptString(input) {
          encryptedBuffer = baseEncryption.encryptString(input);
          return encryptedBuffer;
        },
      },
      createId: () => "atomic-failure",
      renameFile: async () => {
        throw new Error("synthetic rename failure");
      },
    });

    await expect(
      vault.writeCredential({
        token: "synthetic-telegram-token",
        authenticatedAthleteHome: value.athleteHome,
      }),
    ).resolves.toEqual({ status: "refused", reason: "storage-failed" });
    expect(encryptedBuffer?.every((byte) => byte === 0)).toBe(true);
    expect(await readdir(value.root)).toEqual([]);
  });

  it("deletes through a durable tombstone, reports deferred cleanup, and cleans it later", async () => {
    const value = await fixture();
    const encryptionPort = encryption();
    const writer = createTelegramCredentialVault({ ...value, encryption: encryptionPort });
    await writer.writeCredential({
      token: "synthetic-telegram-token",
      authenticatedAthleteHome: value.athleteHome,
    });
    let refuseTombstoneRemoval = true;
    const vault = createTelegramCredentialVault({
      ...value,
      encryption: encryptionPort,
      createId: () => "delete-seam",
      async removeFile(path, options) {
        if (String(path).endsWith(".deleted") && refuseTombstoneRemoval) {
          refuseTombstoneRemoval = false;
          throw new Error("synthetic removal failure");
        }
        await rm(path, options);
      },
    });

    await expect(vault.deleteCredential()).resolves.toEqual({
      status: "deleted",
      cleanupPending: true,
    });
    expect(await readdir(value.root)).toEqual([
      `.${TELEGRAM_CREDENTIAL_FILE_NAME}.delete-seam.deleted`,
    ]);
    await expect(vault.credentialStatus()).resolves.toEqual({ state: "missing" });
    expect(await readdir(value.root)).toEqual([]);
  });

  it("removes bot metadata with the credential and retains tombstones when cleanup is deferred", async () => {
    const value = await fixture();
    const encryptionPort = encryption();
    const writer = createTelegramCredentialVault({ ...value, encryption: encryptionPort });
    await writer.writeCredential({
      token: "synthetic-telegram-token",
      authenticatedAthleteHome: value.athleteHome,
    });
    await writer.writeBotMetadata({
      username: "synthetic_bot",
      authenticatedAthleteHome: value.athleteHome,
    });
    let refuseCleanup = true;
    const vault = createTelegramCredentialVault({
      ...value,
      encryption: encryptionPort,
      createId: () => "coordinated-delete",
      async removeFile(path, options) {
        if (String(path).endsWith(".deleted") && refuseCleanup) {
          refuseCleanup = false;
          throw new Error("synthetic cleanup failure");
        }
        await rm(path, options);
      },
    });

    await expect(vault.deleteCredential()).resolves.toEqual({
      status: "deleted",
      cleanupPending: true,
    });
    const retained = (await readdir(value.root)).sort();
    expect(retained).toEqual(
      [
        `.${TELEGRAM_BOT_METADATA_FILE_NAME}.coordinated-delete.deleted`,
        `.${TELEGRAM_CREDENTIAL_FILE_NAME}.coordinated-delete.deleted`,
      ].sort(),
    );
    await expect(vault.botMetadata()).resolves.toEqual({ state: "missing" });
    await expect(vault.credentialStatus()).resolves.toEqual({ state: "missing" });
    expect(await readdir(value.root)).toEqual([]);
  });

  it("rolls bot metadata back when coordinated credential deletion cannot be made durable", async () => {
    const value = await fixture();
    const encryptionPort = encryption();
    const writer = createTelegramCredentialVault({ ...value, encryption: encryptionPort });
    await writer.writeCredential({
      token: "synthetic-telegram-token",
      authenticatedAthleteHome: value.athleteHome,
    });
    await writer.writeBotMetadata({
      username: "synthetic_bot",
      authenticatedAthleteHome: value.athleteHome,
    });
    let renameCalls = 0;
    const vault = createTelegramCredentialVault({
      ...value,
      encryption: encryptionPort,
      async renameFile(from, to) {
        renameCalls += 1;
        if (renameCalls === 2) throw new Error("synthetic coordinated rename failure");
        await rename(from, to);
      },
    });

    await expect(vault.deleteCredential()).resolves.toEqual({
      status: "refused",
      reason: "storage-failed",
    });
    await expect(vault.botMetadata()).resolves.toEqual({
      state: "configured",
      username: "synthetic_bot",
    });
    await expect(vault.credentialStatus()).resolves.toEqual({ state: "configured" });
    expect((await readdir(value.root)).sort()).toEqual(
      [TELEGRAM_BOT_METADATA_FILE_NAME, TELEGRAM_CREDENTIAL_FILE_NAME].sort(),
    );
  });

  it("rolls a deletion back when tombstone durability cannot be established", async () => {
    const value = await fixture();
    const encryptionPort = encryption();
    const writer = createTelegramCredentialVault({ ...value, encryption: encryptionPort });
    await writer.writeCredential({
      token: "synthetic-telegram-token",
      authenticatedAthleteHome: value.athleteHome,
    });
    let syncCalls = 0;
    const vault = createTelegramCredentialVault({
      ...value,
      encryption: encryptionPort,
      renameFile: rename,
      async syncDirectory(root) {
        syncCalls += 1;
        if (syncCalls === 1) throw new Error("synthetic directory sync failure");
        await syncDirectory(root);
      },
    });

    await expect(vault.deleteCredential()).resolves.toEqual({
      status: "refused",
      reason: "storage-failed",
    });
    await expect(vault.credentialStatus()).resolves.toEqual({ state: "configured" });
    expect((await lstat(join(value.root, TELEGRAM_CREDENTIAL_FILE_NAME))).isFile()).toBe(true);
  });

  it("serializes plaintext application with a concurrent credential deletion", async () => {
    const value = await fixture();
    const vault = createTelegramCredentialVault({ ...value, encryption: encryption() });
    await vault.writeCredential({
      token: "synthetic-telegram-token",
      authenticatedAthleteHome: value.athleteHome,
    });
    let releaseApply!: () => void;
    const applyGate = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    let enteredApply!: () => void;
    const applyEntered = new Promise<void>((resolve) => {
      enteredApply = resolve;
    });
    const apply = vault.applyStoredCredential(value.athleteHome, async () => {
      enteredApply();
      await applyGate;
    });
    await applyEntered;
    let deletionSettled = false;
    const deletion = vault.deleteCredential().then((result) => {
      deletionSettled = true;
      return result;
    });
    await Promise.resolve();
    expect(deletionSettled).toBe(false);

    releaseApply();
    await expect(apply).resolves.toEqual({ status: "applied" });
    await expect(deletion).resolves.toEqual({ status: "deleted", cleanupPending: false });
  });
});
