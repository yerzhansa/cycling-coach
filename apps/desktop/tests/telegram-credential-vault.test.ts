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
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialEncryptionPort } from "../src/main/credential-vault.js";
import {
  TELEGRAM_CREDENTIAL_DIRECTORY_MODE,
  TELEGRAM_CREDENTIAL_FILE_MODE,
  TELEGRAM_DESIRED_STATE_FILE_NAME,
  TELEGRAM_PROFILE_FILE_NAME,
  createTelegramCredentialVault,
  type TelegramProfileRecord,
} from "../src/main/telegram-credential-vault.js";

const fixtureRoots: string[] = [];
const PROFILE_A = "00000000-0000-4000-8000-000000000001";
const PROFILE_B = "00000000-0000-4000-8000-000000000002";
const BOT_A = { id: 123456, username: "synthetic_bot_a" } as const;
const BOT_B = { id: 234567, username: "synthetic_bot_b" } as const;

interface VaultFixture {
  readonly root: string;
  readonly athleteHome: string;
}

async function fixture(): Promise<VaultFixture> {
  const base = await mkdtemp(join(await realpath(tmpdir()), "desktop-telegram-profile-"));
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

async function syncDirectory(root: string): Promise<void> {
  const directory = await open(root, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function seedProfile(
  value: VaultFixture,
  profileId = PROFILE_A,
  token = "synthetic-token-a",
  bot = BOT_A,
): Promise<void> {
  const vault = createTelegramCredentialVault({
    ...value,
    encryption: encryption(),
    createProfileId: () => profileId,
  });
  await expect(
    vault.replaceProfile({ token, bot, authenticatedAthleteHome: value.athleteHome }),
  ).resolves.toMatchObject({ outcome: "applied", profileId, bot });
}

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Telegram credential vault", () => {
  it("reports a missing profile without consulting the encryption backend", async () => {
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

    await expect(vault.profileStatus()).resolves.toEqual({ state: "missing" });
    await expect(vault.desiredState()).resolves.toEqual({ state: "missing", enabled: false });
    expect(isEncryptionAvailable).not.toHaveBeenCalled();
  });

  it("refuses invalid profile input, a foreign authenticated home, and unsafe encryption", async () => {
    const value = await fixture();
    const other = await anotherHome(value.root);
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
      unavailable.replaceProfile({
        token: "synthetic-token-a",
        bot: BOT_A,
        authenticatedAthleteHome: other,
      }),
    ).resolves.toEqual({ outcome: "refused", reason: "wrong-home" });
    await expect(
      unavailable.replaceProfile({
        token: " synthetic-token-a ",
        bot: BOT_A,
        authenticatedAthleteHome: value.athleteHome,
      }),
    ).resolves.toEqual({ outcome: "refused", reason: "invalid-input" });
    await expect(
      unavailable.replaceProfile({
        token: "synthetic-token-a",
        bot: { ...BOT_A, id: 1 },
        authenticatedAthleteHome: value.athleteHome,
      }),
    ).resolves.toEqual({ outcome: "refused", reason: "invalid-input" });
    await expect(
      unavailable.replaceProfile({
        token: "synthetic-token-a",
        bot: BOT_A,
        authenticatedAthleteHome: value.athleteHome,
      }),
    ).resolves.toEqual({ outcome: "refused", reason: "encryption-unavailable" });
    expect(encryptString).not.toHaveBeenCalled();
    await expect(lstat(value.root)).rejects.toMatchObject({ code: "ENOENT" });

    const unsafe = createTelegramCredentialVault({
      ...value,
      encryption: { ...encryption(), getSelectedStorageBackend: () => "basic_text" },
    });
    await expect(
      unsafe.replaceProfile({
        token: "synthetic-token-a",
        bot: BOT_A,
        authenticatedAthleteHome: value.athleteHome,
      }),
    ).resolves.toEqual({ outcome: "refused", reason: "unsafe-backend" });
  });

  it("publishes and reopens one strict owner-only ciphertext profile with no metadata authority", async () => {
    const value = await fixture();
    const token = "synthetic-token-a";
    const baseEncryption = encryption();
    let plaintext = "";
    let encryptedBuffer: Buffer | undefined;
    const vault = createTelegramCredentialVault({
      ...value,
      createProfileId: () => PROFILE_A,
      encryption: {
        ...baseEncryption,
        encryptString(input) {
          plaintext = input;
          encryptedBuffer = baseEncryption.encryptString(input);
          return encryptedBuffer;
        },
      },
    });

    const result = await vault.replaceProfile({
      token,
      bot: BOT_A,
      authenticatedAthleteHome: value.athleteHome,
    });

    expect(result).toEqual({ outcome: "applied", profileId: PROFILE_A, bot: BOT_A });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.parse(plaintext)).toEqual({
      schemaVersion: 1,
      profileId: PROFILE_A,
      athleteHome: value.athleteHome,
      token,
      bot: BOT_A,
    });
    expect(encryptedBuffer?.every((byte) => byte === 0)).toBe(true);
    expect((await lstat(value.root)).mode & 0o777).toBe(TELEGRAM_CREDENTIAL_DIRECTORY_MODE);
    const profilePath = join(value.root, TELEGRAM_PROFILE_FILE_NAME);
    expect((await lstat(profilePath)).mode & 0o777).toBe(TELEGRAM_CREDENTIAL_FILE_MODE);
    const ciphertext = await readFile(profilePath);
    expect(ciphertext.includes(Buffer.from(token))).toBe(false);
    expect(await readdir(value.root)).toEqual([TELEGRAM_PROFILE_FILE_NAME]);
    await expect(vault.profileStatus()).resolves.toEqual({
      state: "configured",
      profileId: PROFILE_A,
      bot: BOT_A,
    });
    const apply = vi.fn(async () => {});
    await expect(vault.applyStoredProfile(value.athleteHome, apply)).resolves.toEqual({
      outcome: "applied",
      profileId: PROFILE_A,
      bot: BOT_A,
    });
    expect(apply).toHaveBeenCalledWith({
      schemaVersion: 1,
      profileId: PROFILE_A,
      athleteHome: value.athleteHome,
      token,
      bot: BOT_A,
    });
  });

  it.each([
    [
      "unavailable encryption",
      {
        isEncryptionAvailable: () => false,
        encryptString: vi.fn(),
        decryptString: vi.fn(),
      } satisfies CredentialEncryptionPort,
      "encryption-unavailable" as const,
    ],
    [
      "an unsafe backend",
      {
        ...encryption(),
        getSelectedStorageBackend: () => "basic_text",
      } satisfies CredentialEncryptionPort,
      "unsafe-backend" as const,
    ],
  ])("preserves %s as a closed status reason after reopen", async (_label, backend, reason) => {
    const value = await fixture();
    await seedProfile(value);
    const reopened = createTelegramCredentialVault({ ...value, encryption: backend });

    await expect(reopened.profileStatus()).resolves.toEqual({ state: "re-prompt", reason });
  });

  it("emits only the exact closed stages at their vault boundaries", async () => {
    const events: unknown[] = [];
    const observeSecureStorageFailure = vi.fn((event: unknown) => {
      events.push(event);
    });

    const encryptionValue = await fixture();
    await seedProfile(encryptionValue);
    const unavailable = createTelegramCredentialVault({
      ...encryptionValue,
      encryption: {
        isEncryptionAvailable: () => false,
        encryptString: vi.fn(),
        decryptString: vi.fn(),
      },
      observeSecureStorageFailure,
    });
    await unavailable.profileStatus();

    const namespaceValue = await fixture();
    await mkdir(namespaceValue.root, { mode: 0o755 });
    const unsafeNamespace = createTelegramCredentialVault({
      ...namespaceValue,
      encryption: encryption(),
      observeSecureStorageFailure,
    });
    await unsafeNamespace.profileStatus();

    const profileValue = await fixture();
    await seedProfile(profileValue);
    const failedProfileWrite = createTelegramCredentialVault({
      ...profileValue,
      encryption: encryption(),
      renameFile: vi.fn(async () => {
        throw new TypeError("private synthetic rename failure");
      }) as never,
      observeSecureStorageFailure,
    });
    await failedProfileWrite.replaceProfile({
      token: "synthetic-token-b",
      bot: BOT_B,
      authenticatedAthleteHome: profileValue.athleteHome,
    });

    const desiredValue = await fixture();
    const desiredSeed = createTelegramCredentialVault({
      ...desiredValue,
      encryption: encryption(),
    });
    await desiredSeed.setDesiredState(false);
    const failedDesiredWrite = createTelegramCredentialVault({
      ...desiredValue,
      encryption: encryption(),
      renameFile: vi.fn(async () => {
        throw new TypeError("private synthetic desired-state failure");
      }) as never,
      observeSecureStorageFailure,
    });
    await failedDesiredWrite.setDesiredState(true);

    expect(events).toEqual([
      { stage: "encryption-availability", reason: "encryption-unavailable" },
      { stage: "namespace", reason: "storage-failed" },
      { stage: "profile-atomic-write", reason: "storage-failed" },
      { stage: "desired-state-write", reason: "storage-failed" },
    ]);
    expect(JSON.stringify(events)).not.toMatch(
      /synthetic-token|private synthetic|telegram-channel-v1/u,
    );
  });

  it("anchors the profile namespace in its parent before publishing ciphertext", async () => {
    const value = await fixture();
    const syncParentDirectory = vi.fn(async (path: string) => {
      expect(path).toBe(dirname(value.root));
      throw new TypeError("synthetic parent sync failure");
    });
    const vault = createTelegramCredentialVault({
      ...value,
      encryption: encryption(),
      createProfileId: () => PROFILE_A,
      syncParentDirectory,
    });

    await expect(
      vault.replaceProfile({
        token: "synthetic-token-a",
        bot: BOT_A,
        authenticatedAthleteHome: value.athleteHome,
      }),
    ).resolves.toEqual({ outcome: "refused", reason: "storage-failed" });
    await expect(lstat(join(value.root, TELEGRAM_PROFILE_FILE_NAME))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(syncParentDirectory).toHaveBeenCalledOnce();
  });

  it("creates token-independent random profile IDs for successive coherent profiles", async () => {
    const value = await fixture();
    const vault = createTelegramCredentialVault({ ...value, encryption: encryption() });
    const first = await vault.replaceProfile({
      token: "synthetic-same-token",
      bot: BOT_A,
      authenticatedAthleteHome: value.athleteHome,
    });
    const second = await vault.replaceProfile({
      token: "synthetic-same-token",
      bot: BOT_A,
      authenticatedAthleteHome: value.athleteHome,
    });

    expect(first).toMatchObject({ outcome: "applied" });
    expect(second).toMatchObject({ outcome: "applied" });
    if (first.outcome !== "applied" || second.outcome !== "applied") throw new TypeError();
    expect(first.profileId).not.toBe(second.profileId);
    expect(first.profileId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns a closed storage refusal when profile ID generation fails", async () => {
    const value = await fixture();
    const vault = createTelegramCredentialVault({
      ...value,
      encryption: encryption(),
      createProfileId: () => {
        throw new TypeError("synthetic profile ID failure");
      },
    });

    await expect(
      vault.replaceProfile({
        token: "synthetic-token-a",
        bot: BOT_A,
        authenticatedAthleteHome: value.athleteHome,
      }),
    ).resolves.toEqual({ outcome: "refused", reason: "storage-failed" });
  });

  it("fails closed for a foreign home and every incomplete or non-strict profile envelope", async () => {
    const value = await fixture();
    const other = await anotherHome(value.root);
    await seedProfile(value);
    const foreign = createTelegramCredentialVault({
      root: value.root,
      athleteHome: other,
      encryption: encryption(),
    });
    await expect(foreign.profileStatus()).resolves.toEqual({ state: "wrong-home" });
    const apply = vi.fn();
    await expect(foreign.applyStoredProfile(other, apply)).resolves.toEqual({
      outcome: "refused",
      reason: "wrong-home",
    });
    expect(apply).not.toHaveBeenCalled();

    const malformed = [
      { schemaVersion: 1, profileId: PROFILE_A, athleteHome: value.athleteHome },
      {
        schemaVersion: 1,
        profileId: PROFILE_A,
        athleteHome: value.athleteHome,
        token: "synthetic-token-a",
        bot: BOT_A,
        metadata: {},
      },
      {
        schemaVersion: 1,
        profileId: "predictable",
        athleteHome: value.athleteHome,
        token: "synthetic-token-a",
        bot: BOT_A,
      },
    ];
    for (const record of malformed) {
      await writeFile(
        join(value.root, TELEGRAM_PROFILE_FILE_NAME),
        encryption().encryptString(JSON.stringify(record)),
        { mode: TELEGRAM_CREDENTIAL_FILE_MODE },
      );
      const vault = createTelegramCredentialVault({ ...value, encryption: encryption() });
      await expect(vault.profileStatus()).resolves.toEqual({
        state: "re-prompt",
        reason: "storage-failed",
      });
      await expect(vault.applyStoredProfile(value.athleteHome, apply)).resolves.toEqual({
        outcome: "refused",
        reason: "re-prompt",
      });
    }
  });

  it("durably restores the prior ciphertext before refusing post-rename profile uncertainty", async () => {
    const value = await fixture();
    await seedProfile(value);
    let syncCount = 0;
    const vault = createTelegramCredentialVault({
      ...value,
      encryption: encryption(),
      createProfileId: () => PROFILE_B,
      createId: () => `replace-${syncCount}`,
      syncDirectory: async () => {
        syncCount += 1;
        if (syncCount === 2) throw new TypeError("synthetic replacement sync failure");
        await syncDirectory(value.root);
      },
    });

    await expect(
      vault.replaceProfile({
        token: "synthetic-token-b",
        bot: BOT_B,
        authenticatedAthleteHome: value.athleteHome,
      }),
    ).resolves.toEqual({ outcome: "refused", reason: "storage-failed" });
    await expect(vault.profileStatus()).resolves.toEqual({
      state: "configured",
      profileId: PROFILE_A,
      bot: BOT_A,
    });
    const apply = vi.fn();
    await vault.applyStoredProfile(value.athleteHome, apply);
    expect(apply.mock.calls[0]?.[0]).toMatchObject({
      profileId: PROFILE_A,
      token: "synthetic-token-a",
      bot: BOT_A,
    });
  });

  it("durably removes a first candidate before refusing initial-write uncertainty", async () => {
    const value = await fixture();
    let syncCount = 0;
    const vault = createTelegramCredentialVault({
      ...value,
      encryption: encryption(),
      createProfileId: () => PROFILE_A,
      createId: () => `initial-${syncCount}`,
      syncDirectory: async () => {
        syncCount += 1;
        if (syncCount === 1) throw new TypeError("synthetic first directory sync failure");
        await syncDirectory(value.root);
      },
    });

    await expect(
      vault.replaceProfile({
        token: "synthetic-token-a",
        bot: BOT_A,
        authenticatedAthleteHome: value.athleteHome,
      }),
    ).resolves.toEqual({ outcome: "refused", reason: "storage-failed" });
    await expect(vault.profileStatus()).resolves.toEqual({ state: "missing" });
    await expect(lstat(join(value.root, TELEGRAM_PROFILE_FILE_NAME))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("blocks replay and reports uncertainty when neither candidate nor prior can converge durably", async () => {
    const value = await fixture();
    await seedProfile(value);
    let syncCount = 0;
    const vault = createTelegramCredentialVault({
      ...value,
      encryption: encryption(),
      createProfileId: () => PROFILE_B,
      createId: () => "never-durable",
      syncDirectory: async () => {
        syncCount += 1;
        if (syncCount === 1) {
          await syncDirectory(value.root);
          return;
        }
        throw new TypeError("synthetic persistent directory sync failure");
      },
    });

    await expect(
      vault.replaceProfile({
        token: "synthetic-token-b",
        bot: BOT_B,
        authenticatedAthleteHome: value.athleteHome,
      }),
    ).resolves.toEqual({ outcome: "uncertain", reason: "storage-uncertain" });
    await expect(vault.profileStatus()).resolves.toEqual({ state: "uncertain" });
    const apply = vi.fn();
    await expect(vault.applyStoredProfile(value.athleteHome, apply)).resolves.toEqual({
      outcome: "uncertain",
      reason: "storage-uncertain",
    });
    expect(apply).not.toHaveBeenCalled();
  });

  it("converges a visible prior profile on reopen before accepting or replaying it", async () => {
    const value = await fixture();
    await seedProfile(value);
    let syncCount = 0;
    const uncertain = createTelegramCredentialVault({
      ...value,
      encryption: encryption(),
      createProfileId: () => PROFILE_B,
      createId: () => "reopen-old",
      syncDirectory: async () => {
        syncCount += 1;
        if (syncCount === 1) {
          await syncDirectory(value.root);
          return;
        }
        throw new TypeError("synthetic indeterminate directory sync");
      },
    });
    await expect(
      uncertain.replaceProfile({
        token: "synthetic-token-b",
        bot: BOT_B,
        authenticatedAthleteHome: value.athleteHome,
      }),
    ).resolves.toEqual({ outcome: "uncertain", reason: "storage-uncertain" });

    const events: string[] = [];
    const baseEncryption = encryption();
    const reopened = createTelegramCredentialVault({
      ...value,
      encryption: {
        ...baseEncryption,
        decryptString(ciphertext) {
          events.push("decrypt");
          return baseEncryption.decryptString(ciphertext);
        },
      },
      syncDirectory: async () => {
        events.push("sync");
        await syncDirectory(value.root);
      },
    });
    await expect(reopened.profileStatus()).resolves.toEqual({
      state: "configured",
      profileId: PROFILE_A,
      bot: BOT_A,
    });
    const apply = vi.fn(async (_profile: TelegramProfileRecord) => {
      events.push("apply");
    });
    await expect(reopened.applyStoredProfile(value.athleteHome, apply)).resolves.toMatchObject({
      outcome: "applied",
      profileId: PROFILE_A,
    });
    expect(apply.mock.calls[0]?.[0]).toMatchObject({
      profileId: PROFILE_A,
      token: "synthetic-token-a",
      bot: BOT_A,
    });
    expect(events).toEqual(["sync", "decrypt", "decrypt", "apply"]);
  });

  it("converges a visible candidate profile on reopen before accepting or replaying it", async () => {
    const value = await fixture();
    await seedProfile(value);
    let syncCount = 0;
    let renameCount = 0;
    const uncertain = createTelegramCredentialVault({
      ...value,
      encryption: encryption(),
      createProfileId: () => PROFILE_B,
      createId: () => "reopen-candidate",
      renameFile: (async (from: string, to: string) => {
        renameCount += 1;
        if (renameCount === 2) throw new TypeError("synthetic compensation rename failure");
        await rename(from, to);
      }) as never,
      syncDirectory: async () => {
        syncCount += 1;
        if (syncCount === 1) {
          await syncDirectory(value.root);
          return;
        }
        throw new TypeError("synthetic indeterminate directory sync");
      },
    });
    await expect(
      uncertain.replaceProfile({
        token: "synthetic-token-b",
        bot: BOT_B,
        authenticatedAthleteHome: value.athleteHome,
      }),
    ).resolves.toEqual({ outcome: "uncertain", reason: "storage-uncertain" });

    const namespaceSync = vi.fn(async () => syncDirectory(value.root));
    const reopened = createTelegramCredentialVault({
      ...value,
      encryption: encryption(),
      syncDirectory: namespaceSync,
    });
    await expect(reopened.profileStatus()).resolves.toEqual({
      state: "configured",
      profileId: PROFILE_B,
      bot: BOT_B,
    });
    const apply = vi.fn(async (_profile: TelegramProfileRecord) => {});
    await expect(reopened.applyStoredProfile(value.athleteHome, apply)).resolves.toMatchObject({
      outcome: "applied",
      profileId: PROFILE_B,
    });
    expect(apply.mock.calls[0]?.[0]).toMatchObject({
      profileId: PROFILE_B,
      token: "synthetic-token-b",
      bot: BOT_B,
    });
    expect(namespaceSync).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed reopen reconciliation uncertain and never replays the visible profile", async () => {
    const value = await fixture();
    await seedProfile(value);
    let syncAttempts = 0;
    const decryptString = vi.fn(encryption().decryptString);
    const reopened = createTelegramCredentialVault({
      ...value,
      encryption: { ...encryption(), decryptString },
      syncDirectory: async () => {
        syncAttempts += 1;
        if (syncAttempts === 1) throw new TypeError("synthetic reopen sync failure");
        await syncDirectory(value.root);
      },
    });

    await expect(reopened.profileStatus()).resolves.toEqual({ state: "uncertain" });
    await expect(reopened.profileStatus()).resolves.toEqual({ state: "uncertain" });
    const apply = vi.fn();
    await expect(reopened.applyStoredProfile(value.athleteHome, apply)).resolves.toEqual({
      outcome: "uncertain",
      reason: "storage-uncertain",
    });
    await expect(reopened.deleteProfile()).resolves.toEqual({
      outcome: "uncertain",
      reason: "storage-uncertain",
    });
    expect(syncAttempts).toBe(1);
    expect(decryptString).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect((await lstat(join(value.root, TELEGRAM_PROFILE_FILE_NAME))).isFile()).toBe(true);
  });

  it("reconciles only exact vault-owned transient artifacts before reading a profile", async () => {
    const value = await fixture();
    await seedProfile(value);
    const exact = [
      `.${TELEGRAM_PROFILE_FILE_NAME}.profile-tmp.tmp`,
      `.${TELEGRAM_PROFILE_FILE_NAME}.profile-deleted.deleted`,
      `.${TELEGRAM_DESIRED_STATE_FILE_NAME}.desired-tmp.tmp`,
      `.${TELEGRAM_DESIRED_STATE_FILE_NAME}.desired-deleted.deleted`,
    ];
    const lookalikes = [
      `.${TELEGRAM_PROFILE_FILE_NAME}.bad_id.tmp`,
      `.${TELEGRAM_PROFILE_FILE_NAME}.valid.tmp.extra`,
      `.${TELEGRAM_DESIRED_STATE_FILE_NAME}.${"a".repeat(129)}.deleted`,
      ".unowned.json.valid.deleted",
    ];
    await Promise.all(
      [...exact, ...lookalikes].map((entry) =>
        writeFile(join(value.root, entry), "synthetic transient", {
          mode: TELEGRAM_CREDENTIAL_FILE_MODE,
        }),
      ),
    );
    const removeFile = vi.fn(async (path: string, options?: { force?: boolean }) => {
      await rm(path, options);
    });
    const namespaceSync = vi.fn(async () => syncDirectory(value.root));
    const reopened = createTelegramCredentialVault({
      ...value,
      encryption: encryption(),
      removeFile: removeFile as never,
      syncDirectory: namespaceSync,
    });

    await expect(reopened.profileStatus()).resolves.toMatchObject({
      state: "configured",
      profileId: PROFILE_A,
    });
    expect(removeFile.mock.calls.map(([path]) => String(path)).sort()).toEqual(
      exact.map((entry) => join(value.root, entry)).sort(),
    );
    const remaining = await readdir(value.root);
    expect(exact.some((entry) => remaining.includes(entry))).toBe(false);
    expect(lookalikes.every((entry) => remaining.includes(entry))).toBe(true);
    expect(namespaceSync).toHaveBeenCalledTimes(1);
  });

  it("treats an unsynced tombstone cleanup as permanently uncertain", async () => {
    const value = await fixture();
    await seedProfile(value);
    await writeFile(
      join(value.root, `.${TELEGRAM_PROFILE_FILE_NAME}.cleanup.deleted`),
      "synthetic tombstone",
      { mode: TELEGRAM_CREDENTIAL_FILE_MODE },
    );
    let syncAttempts = 0;
    const reopened = createTelegramCredentialVault({
      ...value,
      encryption: encryption(),
      syncDirectory: async () => {
        syncAttempts += 1;
        if (syncAttempts === 1) throw new TypeError("synthetic cleanup sync failure");
        await syncDirectory(value.root);
      },
    });

    await expect(reopened.profileStatus()).resolves.toEqual({ state: "uncertain" });
    await expect(reopened.profileStatus()).resolves.toEqual({ state: "uncertain" });
    expect(syncAttempts).toBe(1);
  });

  it("keeps the prior profile on pre-rename failure and zeroes produced ciphertext", async () => {
    const value = await fixture();
    await seedProfile(value);
    const baseEncryption = encryption();
    let encrypted: Buffer | undefined;
    const vault = createTelegramCredentialVault({
      ...value,
      createProfileId: () => PROFILE_B,
      encryption: {
        ...baseEncryption,
        encryptString(input) {
          encrypted = baseEncryption.encryptString(input);
          return encrypted;
        },
      },
      renameFile: vi.fn(async () => {
        throw new TypeError("synthetic rename failure");
      }) as never,
    });

    await expect(
      vault.replaceProfile({
        token: "synthetic-token-b",
        bot: BOT_B,
        authenticatedAthleteHome: value.athleteHome,
      }),
    ).resolves.toEqual({ outcome: "refused", reason: "storage-failed" });
    expect(encrypted?.every((byte) => byte === 0)).toBe(true);
    const reopened = createTelegramCredentialVault({ ...value, encryption: encryption() });
    await expect(reopened.profileStatus()).resolves.toMatchObject({
      state: "configured",
      profileId: PROFILE_A,
      bot: BOT_A,
    });
    expect((await readdir(value.root)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("stores desired state separately without encryption and durably compensates uncertainty", async () => {
    const value = await fixture();
    const encryptString = vi.fn();
    const decryptString = vi.fn();
    const seed = createTelegramCredentialVault({
      ...value,
      encryption: { isEncryptionAvailable: () => false, encryptString, decryptString },
    });
    await expect(seed.setDesiredState(false)).resolves.toEqual({
      status: "stored",
      enabled: false,
    });
    let syncCount = 0;
    const vault = createTelegramCredentialVault({
      ...value,
      encryption: { isEncryptionAvailable: () => false, encryptString, decryptString },
      createId: () => `desired-${syncCount}`,
      syncDirectory: async () => {
        syncCount += 1;
        if (syncCount === 2) throw new TypeError("synthetic replacement sync failure");
        await syncDirectory(value.root);
      },
    });

    await expect(vault.setDesiredState(true)).resolves.toEqual({
      status: "refused",
      reason: "storage-failed",
    });
    await expect(vault.desiredState()).resolves.toEqual({ state: "configured", enabled: false });
    expect(encryptString).not.toHaveBeenCalled();
    expect(decryptString).not.toHaveBeenCalled();
    expect(
      JSON.parse(await readFile(join(value.root, TELEGRAM_DESIRED_STATE_FILE_NAME), "utf8")),
    ).toEqual({ schemaVersion: 1, athleteHome: value.athleteHome, enabled: false });
  });

  it("marks desired state uncertain when durable compensation cannot be proven", async () => {
    const value = await fixture();
    const seed = createTelegramCredentialVault({ ...value, encryption: encryption() });
    await seed.setDesiredState(false);
    let syncCount = 0;
    const vault = createTelegramCredentialVault({
      ...value,
      encryption: encryption(),
      createId: () => "desired-uncertain",
      syncDirectory: async () => {
        syncCount += 1;
        if (syncCount === 1) {
          await syncDirectory(value.root);
          return;
        }
        throw new TypeError("synthetic persistent directory sync failure");
      },
    });

    await expect(vault.setDesiredState(true)).resolves.toEqual({
      status: "uncertain",
      reason: "storage-uncertain",
    });
    await expect(vault.desiredState()).resolves.toEqual({ state: "uncertain", enabled: false });
  });

  it("never exposes a refused enable as enabled after a successful reopen convergence", async () => {
    const value = await fixture();
    const seed = createTelegramCredentialVault({ ...value, encryption: encryption() });
    await expect(seed.setDesiredState(false)).resolves.toEqual({
      status: "stored",
      enabled: false,
    });
    const refused = createTelegramCredentialVault({
      ...value,
      encryption: encryption(),
      renameFile: vi.fn(async () => {
        throw new TypeError("synthetic pre-rename failure");
      }) as never,
    });
    await expect(refused.setDesiredState(true)).resolves.toEqual({
      status: "refused",
      reason: "storage-failed",
    });

    const namespaceSync = vi.fn(async () => syncDirectory(value.root));
    const reopened = createTelegramCredentialVault({
      ...value,
      encryption: encryption(),
      syncDirectory: namespaceSync,
    });
    await expect(reopened.desiredState()).resolves.toEqual({
      state: "configured",
      enabled: false,
    });
    expect(namespaceSync).toHaveBeenCalledTimes(1);
  });

  it("accepts an uncertain visible enable only after a fresh reopen converges it", async () => {
    const value = await fixture();
    const seed = createTelegramCredentialVault({ ...value, encryption: encryption() });
    await seed.setDesiredState(false);
    let syncCount = 0;
    let renameCount = 0;
    const uncertain = createTelegramCredentialVault({
      ...value,
      encryption: encryption(),
      createId: () => "uncertain-enable-candidate",
      renameFile: (async (from: string, to: string) => {
        renameCount += 1;
        if (renameCount === 2) throw new TypeError("synthetic compensation rename failure");
        await rename(from, to);
      }) as never,
      syncDirectory: async () => {
        syncCount += 1;
        if (syncCount === 1) {
          await syncDirectory(value.root);
          return;
        }
        throw new TypeError("synthetic indeterminate directory sync");
      },
    });
    await expect(uncertain.setDesiredState(true)).resolves.toEqual({
      status: "uncertain",
      reason: "storage-uncertain",
    });
    expect(
      JSON.parse(await readFile(join(value.root, TELEGRAM_DESIRED_STATE_FILE_NAME), "utf8")),
    ).toMatchObject({ enabled: true });

    const namespaceSync = vi.fn(async () => syncDirectory(value.root));
    const reopened = createTelegramCredentialVault({
      ...value,
      encryption: encryption(),
      syncDirectory: namespaceSync,
    });
    await expect(reopened.desiredState()).resolves.toEqual({
      state: "configured",
      enabled: true,
    });
    expect(namespaceSync).toHaveBeenCalledTimes(1);
  });

  it("keeps an uncertain visible enable disabled while reopen convergence is indeterminate", async () => {
    const value = await fixture();
    const seed = createTelegramCredentialVault({ ...value, encryption: encryption() });
    await seed.setDesiredState(false);
    let syncCount = 0;
    let renameCount = 0;
    const uncertain = createTelegramCredentialVault({
      ...value,
      encryption: encryption(),
      createId: () => "indeterminate-enable-candidate",
      renameFile: (async (from: string, to: string) => {
        renameCount += 1;
        if (renameCount === 2) throw new TypeError("synthetic compensation rename failure");
        await rename(from, to);
      }) as never,
      syncDirectory: async () => {
        syncCount += 1;
        if (syncCount === 1) {
          await syncDirectory(value.root);
          return;
        }
        throw new TypeError("synthetic indeterminate directory sync");
      },
    });
    await expect(uncertain.setDesiredState(true)).resolves.toMatchObject({ status: "uncertain" });

    let reopenSyncAttempts = 0;
    const reopened = createTelegramCredentialVault({
      ...value,
      encryption: encryption(),
      syncDirectory: async () => {
        reopenSyncAttempts += 1;
        if (reopenSyncAttempts === 1) throw new TypeError("synthetic reopen sync failure");
        await syncDirectory(value.root);
      },
    });
    await expect(reopened.desiredState()).resolves.toEqual({
      state: "uncertain",
      enabled: false,
    });
    await expect(reopened.desiredState()).resolves.toEqual({
      state: "uncertain",
      enabled: false,
    });
    expect(reopenSyncAttempts).toBe(1);
  });

  it("refuses symlinked and permissive profile storage", async () => {
    const value = await fixture();
    const actual = join(value.root, "..", "actual-vault");
    await mkdir(actual, { mode: TELEGRAM_CREDENTIAL_DIRECTORY_MODE });
    await symlink(actual, value.root);
    const symlinkedRoot = createTelegramCredentialVault({ ...value, encryption: encryption() });
    await expect(
      symlinkedRoot.replaceProfile({
        token: "synthetic-token-a",
        bot: BOT_A,
        authenticatedAthleteHome: value.athleteHome,
      }),
    ).resolves.toEqual({ outcome: "refused", reason: "storage-failed" });

    await rm(value.root);
    await mkdir(value.root, { mode: TELEGRAM_CREDENTIAL_DIRECTORY_MODE });
    const outside = join(value.root, "..", "outside-profile");
    await writeFile(outside, "ciphertext", { mode: TELEGRAM_CREDENTIAL_FILE_MODE });
    await symlink(outside, join(value.root, TELEGRAM_PROFILE_FILE_NAME));
    const symlinkedFile = createTelegramCredentialVault({ ...value, encryption: encryption() });
    await expect(symlinkedFile.profileStatus()).resolves.toEqual({
      state: "re-prompt",
      reason: "storage-failed",
    });
    await expect(
      symlinkedFile.replaceProfile({
        token: "synthetic-token-a",
        bot: BOT_A,
        authenticatedAthleteHome: value.athleteHome,
      }),
    ).resolves.toEqual({ outcome: "refused", reason: "storage-failed" });

    await rm(join(value.root, TELEGRAM_PROFILE_FILE_NAME));
    await chmod(value.root, 0o755);
    await expect(symlinkedFile.profileStatus()).resolves.toEqual({
      state: "re-prompt",
      reason: "storage-failed",
    });
  });

  it("deletes through a durable tombstone and cleans deferred ciphertext later", async () => {
    const value = await fixture();
    await seedProfile(value);
    const removeFile = vi.fn(async (path: string, options?: { force?: boolean }) => {
      if (path.endsWith(".deleted")) throw new TypeError("synthetic cleanup failure");
      await rm(path, options);
    });
    const vault = createTelegramCredentialVault({
      ...value,
      encryption: encryption(),
      createId: () => "delete-profile",
      removeFile: removeFile as never,
    });

    await expect(vault.deleteProfile()).resolves.toEqual({
      outcome: "applied",
      cleanupPending: true,
    });
    await expect(lstat(join(value.root, TELEGRAM_PROFILE_FILE_NAME))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await readdir(value.root)).some((entry) => entry.endsWith(".deleted"))).toBe(true);
    const reopened = createTelegramCredentialVault({ ...value, encryption: encryption() });
    await expect(reopened.profileStatus()).resolves.toEqual({ state: "missing" });
    expect((await readdir(value.root)).some((entry) => entry.endsWith(".deleted"))).toBe(false);
  });

  it("refuses deletion when the tombstone id is invalid instead of rejecting", async () => {
    const value = await fixture();
    await seedProfile(value);
    const vault = createTelegramCredentialVault({
      ...value,
      encryption: encryption(),
      createId: () => {
        throw new TypeError("synthetic id failure");
      },
    });

    await expect(vault.deleteProfile()).resolves.toEqual({
      outcome: "refused",
      reason: "storage-failed",
    });
    await expect(vault.profileStatus()).resolves.toMatchObject({ state: "configured" });
  });

  it("restores a profile when tombstone durability fails and reports uncertainty if restore fails", async () => {
    const value = await fixture();
    await seedProfile(value);
    let syncCount = 0;
    const restored = createTelegramCredentialVault({
      ...value,
      encryption: encryption(),
      createId: () => "restore-profile",
      syncDirectory: async () => {
        syncCount += 1;
        if (syncCount === 2) throw new TypeError("synthetic tombstone sync failure");
        await syncDirectory(value.root);
      },
    });
    await expect(restored.deleteProfile()).resolves.toEqual({
      outcome: "refused",
      reason: "storage-failed",
    });
    await expect(restored.profileStatus()).resolves.toMatchObject({
      state: "configured",
      profileId: PROFILE_A,
    });

    let renameCount = 0;
    let uncertainSyncCount = 0;
    const uncertain = createTelegramCredentialVault({
      ...value,
      encryption: encryption(),
      createId: () => "uncertain-delete",
      renameFile: (async (from: string, to: string) => {
        renameCount += 1;
        if (renameCount === 2) throw new TypeError("synthetic restore failure");
        await rename(from, to);
      }) as never,
      syncDirectory: async () => {
        uncertainSyncCount += 1;
        if (uncertainSyncCount === 1) {
          await syncDirectory(value.root);
          return;
        }
        throw new TypeError("synthetic tombstone sync failure");
      },
    });
    await expect(uncertain.deleteProfile()).resolves.toEqual({
      outcome: "uncertain",
      reason: "storage-uncertain",
    });
    await expect(uncertain.profileStatus()).resolves.toEqual({ state: "uncertain" });
    const apply = vi.fn();
    await expect(uncertain.applyStoredProfile(value.athleteHome, apply)).resolves.toEqual({
      outcome: "uncertain",
      reason: "storage-uncertain",
    });
    expect(apply).not.toHaveBeenCalled();
  });

  it("serializes plaintext application with profile deletion", async () => {
    const value = await fixture();
    await seedProfile(value);
    const vault = createTelegramCredentialVault({ ...value, encryption: encryption() });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const apply = vault.applyStoredProfile(value.athleteHome, async () => {
      expect((await lstat(join(value.root, TELEGRAM_PROFILE_FILE_NAME))).isFile()).toBe(true);
      await gate;
    });
    const deletion = vault.deleteProfile();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await lstat(join(value.root, TELEGRAM_PROFILE_FILE_NAME))).isFile()).toBe(true);
    release();

    await expect(apply).resolves.toMatchObject({ outcome: "applied", profileId: PROFILE_A });
    await expect(deletion).resolves.toEqual({ outcome: "applied", cleanupPending: false });
  });
});
