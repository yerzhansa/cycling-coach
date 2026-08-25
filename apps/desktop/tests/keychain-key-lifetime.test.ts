import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindWindowsPrivateDirectory } from "@enduragent/core";
import { createAutomaticKeyRetirementInspector } from "../src/main/automatic-key-retirement.js";
import {
  createCredentialVault,
  CREDENTIAL_DIRECTORY_MODE,
  CREDENTIAL_FILE_MODE,
  type CredentialEncryptionPort,
  type DesktopCredentialSlot,
} from "../src/main/credential-vault.js";
import { createCredentialEnvelopeMutationLock } from "../src/main/credential-envelope-lock.js";
import { classifyCredentialEnvelopeRemoval } from "../src/main/credential-envelope-inspection.js";
import {
  CREDENTIAL_ENVELOPE_DIRECTORY_ENTRY_LIMIT,
  credentialEnvelopeTargets,
  inspectCredentialEnvelopeTarget,
  readCredentialEnvelopeDirectory,
  scanCredentialEnvelopes,
} from "../src/main/credential-envelope-inventory.js";
import {
  createKeychainPartitionEncryption,
  sealCredentialEnvelope,
} from "../src/main/keychain-credential-encryption.js";
import {
  KEYCHAIN_CREDENTIAL_SERVICE,
  KEYCHAIN_KEY_BYTES,
  KEYCHAIN_TEAM_IDENTIFIER,
  type KeychainBindingRequest,
  type KeychainBindingResponse,
  type KeychainBindingTransport,
} from "../src/main/keychain-binding.js";
import { retireKeychainKeyWhenLastEnvelopeGone } from "../src/main/keychain-key-lifetime.js";
import {
  TELEGRAM_CREDENTIAL_DIRECTORY_MODE,
  TELEGRAM_CREDENTIAL_FILE_MODE,
  TELEGRAM_DESIRED_STATE_FILE_NAME,
  TELEGRAM_PROFILE_FILE_NAME,
  createTelegramCredentialVault,
} from "../src/main/telegram-credential-vault.js";
import { TELEGRAM_POWER_STATE_FILE_NAME } from "../src/main/telegram-power.js";

const fixtureRoots: string[] = [];
const posixIt = it.skipIf(process.platform === "win32");
const BOT = { id: 123456, username: "synthetic_bot" } as const;
const PROBE_OK: KeychainBindingResponse = {
  ok: true,
  op: "probe",
  teamIdentifier: KEYCHAIN_TEAM_IDENTIFIER,
};
const execFileAsync = promisify(execFile);

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

interface RecordingTransport extends KeychainBindingTransport {
  readonly requests: KeychainBindingRequest[];
}

function transportOf(...responses: readonly KeychainBindingResponse[]): RecordingTransport {
  const remaining = [...responses];
  const requests: KeychainBindingRequest[] = [];
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
  const serialize = createCredentialEnvelopeMutationLock();
  const result = await serialize((lockProof) =>
    createKeychainPartitionEncryption({
      transport: transportOf(
        PROBE_OK,
        { ok: true, op: "retry-created-key-rollback" },
        {
          ok: true,
          op: "read-key",
          key: randomBytes(KEYCHAIN_KEY_BYTES),
        },
      ),
      service: KEYCHAIN_CREDENTIAL_SERVICE,
      inspectAutomaticRetirement: async () => ({
        status: "inspected",
        deletionBlockers: 1,
        keychainDependents: 1,
        unverified: 0,
        zeroProof: null,
      }),
      lockProof,
    }),
  );
  if (result.status !== "ready") throw new TypeError();
  return result.encryption;
}

async function retireKey(
  roots: Fixture,
  transport: RecordingTransport,
  readEnvelopeFile?: (path: string) => Promise<Buffer>,
  readEnvelopeDirectory?: (path: string) => Promise<string[]>,
) {
  const serialize = createCredentialEnvelopeMutationLock();
  const inspect = createAutomaticKeyRetirementInspector({
    ...roots,
    readEnvelopeFile,
    readEnvelopeDirectory,
  });
  return await serialize((lockProof) =>
    retireKeychainKeyWhenLastEnvelopeGone({
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
    }),
  );
}

function credentialVault(roots: Fixture, encryption: CredentialEncryptionPort) {
  const serializeEnvelopeMutation = createCredentialEnvelopeMutationLock();
  return createCredentialVault({
    root: roots.credentialRoot,
    encryption,
    applyCredential: vi.fn(async () => undefined),
    clearCredential: vi.fn(async () => "not-active" as const),
    serializeEnvelopeMutation,
    revalidateEnvelopeRemoval: vi.fn(async () => true),
  });
}

function telegramVault(roots: Fixture, encryption: CredentialEncryptionPort) {
  const serializeEnvelopeMutation = createCredentialEnvelopeMutationLock();
  return createTelegramCredentialVault({
    root: roots.telegramRoot,
    athleteHome: roots.athleteHome,
    encryption,
    serializeEnvelopeMutation,
    revalidateEnvelopeRemoval: vi.fn(async () => true),
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
  posixIt("refuses key retirement when a credential root redirects", async () => {
    const roots = await fixture();
    const hiddenRoot = `${roots.credentialRoot}-hidden`;
    const redirectedRoot = `${roots.credentialRoot}-redirected`;
    const hiddenEnvelope = join(hiddenRoot, "anthropic.bin");
    await mkdir(hiddenRoot, { mode: CREDENTIAL_DIRECTORY_MODE });
    await mkdir(redirectedRoot, { mode: CREDENTIAL_DIRECTORY_MODE });
    await writeFile(hiddenEnvelope, "hidden-envelope");
    await symlink(redirectedRoot, roots.credentialRoot, "dir");
    const transport = transportOf({ ok: true, op: "delete-key", deleted: true });

    await expect(retireKey(roots, transport)).resolves.toEqual({
      status: "failed",
      code: "unknown",
      keyCleanupPending: false,
    });
    expect(transport.requests).toHaveLength(0);
    await expect(readFile(hiddenEnvelope, "utf8")).resolves.toBe("hidden-envelope");
  });

  posixIt("retires the key when both credential roots remain missing", async () => {
    const roots = await fixture();
    const readEnvelopeFile = vi.fn(async () => Buffer.from("must-not-be-read"));
    const readEnvelopeDirectory = vi.fn(async () => ["must-not-be-read.bin"]);
    const transport = transportOf({ ok: true, op: "delete-key", deleted: true });

    await expect(
      retireKey(roots, transport, readEnvelopeFile as never, readEnvelopeDirectory),
    ).resolves.toEqual({ status: "deleted" });
    expect(readEnvelopeFile).not.toHaveBeenCalled();
    expect(readEnvelopeDirectory).not.toHaveBeenCalled();
  });

  posixIt("keeps the key for a dangling canonical envelope symlink", async () => {
    const roots = await fixture();
    await mkdir(roots.credentialRoot, { mode: CREDENTIAL_DIRECTORY_MODE });
    await symlink(
      join(roots.credentialRoot, "missing-envelope"),
      join(roots.credentialRoot, "anthropic.bin"),
    );
    const transport = transportOf();

    await expect(retireKey(roots, transport)).resolves.toEqual({
      status: "retained",
      envelopes: 1,
    });
    expect(transport.requests).toHaveLength(0);
  });

  posixIt("keeps the key for a canonical envelope symlink to a readable file", async () => {
    const roots = await fixture();
    await mkdir(roots.credentialRoot, { mode: CREDENTIAL_DIRECTORY_MODE });
    const source = join(roots.credentialRoot, "source-envelope");
    await writeFile(source, Buffer.alloc(64), { mode: 0o600 });
    await symlink(source, join(roots.credentialRoot, "anthropic.bin"));
    const transport = transportOf();

    await expect(retireKey(roots, transport)).resolves.toEqual({
      status: "retained",
      envelopes: 2,
    });
    expect(transport.requests).toHaveLength(0);
  });

  posixIt("inspects a canonical FIFO without opening or waiting on it", async () => {
    const roots = await fixture();
    await mkdir(roots.credentialRoot, { mode: CREDENTIAL_DIRECTORY_MODE });
    const fifo = join(roots.credentialRoot, "anthropic.bin");
    await execFileAsync("mkfifo", [fifo]);
    await chmod(fifo, 0o600);
    const transport = transportOf();

    await expect(
      Promise.race([
        retireKey(roots, transport),
        new Promise((_, reject) => setTimeout(() => reject(new Error("FIFO read waited")), 1_000)),
      ]),
    ).resolves.toEqual({ status: "retained", envelopes: 1 });
    expect(transport.requests).toHaveLength(0);
  });

  posixIt("keeps the key for a canonical envelope with unsafe permissions", async () => {
    const roots = await fixture();
    await mkdir(roots.credentialRoot, { mode: CREDENTIAL_DIRECTORY_MODE });
    await writeFile(join(roots.credentialRoot, "anthropic.bin"), Buffer.alloc(64), {
      mode: 0o644,
    });

    await expect(retireKey(roots, transportOf())).resolves.toEqual({
      status: "retained",
      envelopes: 1,
    });
  });

  posixIt("reads only the classification prefix from a huge sparse envelope", async () => {
    const roots = await fixture();
    await mkdir(roots.credentialRoot, { mode: CREDENTIAL_DIRECTORY_MODE });
    const path = join(roots.credentialRoot, "anthropic.bin");
    const envelope = sealCredentialEnvelope(randomBytes(KEYCHAIN_KEY_BYTES), "bounded-prefix");
    const handle = await open(path, "w", 0o600);
    await handle.write(envelope, 0, envelope.length, 0);
    await handle.truncate(128 * 1024 * 1024);
    await handle.close();
    const target = credentialEnvelopeTargets(roots).find(
      (candidate) => candidate.fileName === "anthropic.bin",
    )!;

    const inspected = await inspectCredentialEnvelopeTarget(target);

    expect(inspected.status).toBe("readable");
    if (inspected.status === "readable") {
      expect(inspected.contents).toHaveLength(40);
      inspected.contents.fill(0);
    }
    const windowsInspection = await inspectCredentialEnvelopeTarget(target, {
      platform: "win32",
      windowsDirectory: bindWindowsPrivateDirectory(
        dirname(roots.credentialRoot),
        roots.credentialRoot,
      ),
    });
    expect(windowsInspection.status).toBe("readable");
    if (windowsInspection.status === "readable") {
      expect(windowsInspection.contents).toHaveLength(40);
      windowsInspection.contents.fill(0);
    }
    envelope.fill(0);
  });

  posixIt("classifies equivalent envelopes identically in both vaults", async () => {
    const roots = await fixture();
    await mkdir(roots.credentialRoot, { mode: CREDENTIAL_DIRECTORY_MODE });
    await mkdir(roots.telegramRoot, { mode: TELEGRAM_CREDENTIAL_DIRECTORY_MODE });
    const envelope = sealCredentialEnvelope(randomBytes(KEYCHAIN_KEY_BYTES), "classifier-parity");
    await writeFile(join(roots.credentialRoot, "anthropic.bin"), envelope, { mode: 0o600 });
    await writeFile(join(roots.telegramRoot, TELEGRAM_PROFILE_FILE_NAME), envelope, {
      mode: TELEGRAM_CREDENTIAL_FILE_MODE,
    });
    const targets = credentialEnvelopeTargets(roots).filter(
      (target) =>
        target.fileName === "anthropic.bin" || target.fileName === TELEGRAM_PROFILE_FILE_NAME,
    );

    await expect(
      Promise.all(targets.map((target) => classifyCredentialEnvelopeRemoval(target))),
    ).resolves.toEqual(["keychain-dependent", "keychain-dependent"]);

    envelope.fill(0);
  });

  posixIt("blocks deletion when a canonical envelope is replaced during inspection", async () => {
    const roots = await fixture();
    await mkdir(roots.credentialRoot, { mode: CREDENTIAL_DIRECTORY_MODE });
    const path = join(roots.credentialRoot, "anthropic.bin");
    const displaced = `${path}.old`;
    await writeFile(path, Buffer.alloc(64), { mode: 0o600 });
    const target = credentialEnvelopeTargets(roots).find(
      (candidate) => candidate.fileName === "anthropic.bin",
    )!;
    const openAndReplace: typeof open = async (...arguments_) => {
      const handle = await open(...arguments_);
      await rename(path, displaced);
      await writeFile(path, Buffer.alloc(64, 1), { mode: 0o600 });
      return handle;
    };

    await expect(
      inspectCredentialEnvelopeTarget(target, { openFile: openAndReplace }),
    ).resolves.toEqual({ status: "blocked" });
  });

  posixIt("blocks deletion when a canonical envelope appears after the first check", async () => {
    const roots = await fixture();
    const envelope = sealCredentialEnvelope(randomBytes(KEYCHAIN_KEY_BYTES), "appeared");
    let anthropicInspections = 0;

    const inventory = await scanCredentialEnvelopes({
      ...roots,
      inspectEnvelopeTarget: async (target) => {
        if (target.fileName !== "anthropic.bin") return { status: "missing" };
        anthropicInspections += 1;
        return anthropicInspections === 1
          ? { status: "missing" }
          : { status: "readable", contents: Buffer.from(envelope) };
      },
      readEnvelopeDirectory: async () => [],
    });

    expect(inventory.deletionBlockers).toHaveLength(1);
    expect(inventory.keychainDependents).toBe(1);
    envelope.fill(0);
  });

  posixIt("keeps the key while any envelope survives in either vault", async () => {
    const roots = await fixture();
    const encryption = await keychainEncryption();
    await seedCredential(roots, "anthropic", "sk-anthropic", encryption);
    await seedProfile(roots, encryption);
    const transport = transportOf();

    await expect(
      credentialVault(roots, encryption).deleteCredential("anthropic"),
    ).resolves.toMatchObject({ slot: "anthropic", status: "deleted" });

    await expect(retireKey(roots, transport)).resolves.toEqual({
      status: "retained",
      envelopes: 1,
    });
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
    await expect(retireKey(roots, transport)).resolves.toMatchObject({ status: "retained" });

    await expect(telegramVault(roots, encryption).deleteProfile()).resolves.toMatchObject({
      outcome: "applied",
    });

    await expect(retireKey(roots, transport)).resolves.toEqual({ status: "deleted" });
    expect(transport.requests).toEqual([
      { op: "delete-key", service: KEYCHAIN_CREDENTIAL_SERVICE },
    ]);
  });

  posixIt("keeps the key while an envelope exists but cannot be read", async () => {
    const roots = await fixture();
    await mkdir(roots.credentialRoot, { mode: CREDENTIAL_DIRECTORY_MODE });
    const envelopePath = join(roots.credentialRoot, "anthropic.bin");
    await writeFile(envelopePath, "unreadable-envelope", { mode: CREDENTIAL_FILE_MODE });
    const readEnvelopeFile = vi.fn(async (path: string) => {
      if (path === envelopePath) {
        throw Object.assign(new Error("synthetic read failure"), { code: "EACCES" });
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    const transport = transportOf();

    await expect(retireKey(roots, transport, readEnvelopeFile)).resolves.toMatchObject({
      status: "retained",
    });
    expect(readEnvelopeFile).toHaveBeenCalledWith(envelopePath);
    expect(transport.requests).toHaveLength(0);
  });

  posixIt("keeps the key while recognised transient envelope artifacts survive", async () => {
    const roots = await fixture();
    await mkdir(roots.credentialRoot, { recursive: true, mode: CREDENTIAL_DIRECTORY_MODE });
    await mkdir(roots.telegramRoot, {
      recursive: true,
      mode: TELEGRAM_CREDENTIAL_DIRECTORY_MODE,
    });
    await writeFile(join(roots.credentialRoot, ".anthropic.bin.write-1.tmp"), "credential");
    await writeFile(
      join(roots.telegramRoot, `.${TELEGRAM_PROFILE_FILE_NAME}.delete-1.deleted`),
      "telegram",
    );
    await writeFile(join(roots.credentialRoot, ".anthropic.bin.bad_id.tmp"), "unrelated");
    const transport = transportOf();

    await expect(retireKey(roots, transport)).resolves.toEqual({
      status: "retained",
      envelopes: 3,
    });
    expect(transport.requests).toHaveLength(0);
  });

  posixIt("counts only canonical legacy envelopes as user-facing recovery", async () => {
    const roots = await fixture();
    await mkdir(roots.credentialRoot, { recursive: true, mode: CREDENTIAL_DIRECTORY_MODE });
    await writeFile(join(roots.credentialRoot, "anthropic.bin"), "legacy-canonical");
    await writeFile(join(roots.credentialRoot, ".openrouter.bin.write-1.tmp"), "legacy-transient");

    const inventory = await scanCredentialEnvelopes(roots);

    expect(inventory.deletionBlockers).toHaveLength(2);
    expect(inventory.keychainDependents).toBe(0);
    expect(inventory.unverified).toBe(1);
  });

  posixIt("keeps transient-only recovery out of the user-facing count", async () => {
    const roots = await fixture();
    await mkdir(roots.credentialRoot, { recursive: true, mode: CREDENTIAL_DIRECTORY_MODE });
    await writeFile(join(roots.credentialRoot, ".anthropic.bin.write-1.tmp"), "transient");
    const transport = transportOf();

    const inventory = await scanCredentialEnvelopes(roots);

    expect(inventory.deletionBlockers).toHaveLength(1);
    expect(inventory.unverified).toBe(0);
    await expect(retireKey(roots, transport)).resolves.toEqual({
      status: "retained",
      envelopes: 1,
    });
    expect(transport.requests).toHaveLength(0);
  });

  posixIt("fails closed when a credential directory exceeds the census limit", async () => {
    const roots = await fixture();
    await mkdir(roots.credentialRoot, { mode: CREDENTIAL_DIRECTORY_MODE });
    await Promise.all(
      Array.from({ length: CREDENTIAL_ENVELOPE_DIRECTORY_ENTRY_LIMIT + 1 }, (_, index) =>
        writeFile(join(roots.credentialRoot, `entry-${index}`), "ignored"),
      ),
    );

    await expect(readCredentialEnvelopeDirectory(roots.credentialRoot)).rejects.toThrow(
      "credential envelope directory entry limit exceeded",
    );
    await expect(
      scanCredentialEnvelopes({
        ...roots,
        readEnvelopeDirectory: async () =>
          Array.from(
            { length: CREDENTIAL_ENVELOPE_DIRECTORY_ENTRY_LIMIT + 1 },
            (_, index) => `entry-${index}`,
          ),
      }),
    ).rejects.toThrow("credential envelope directory entry limit exceeded");
  });

  posixIt("counts a transient key-id one envelope as a keychain dependent", async () => {
    const roots = await fixture();
    await mkdir(roots.telegramRoot, {
      recursive: true,
      mode: TELEGRAM_CREDENTIAL_DIRECTORY_MODE,
    });
    const envelope = sealCredentialEnvelope(randomBytes(KEYCHAIN_KEY_BYTES), "transient-token");
    await writeFile(
      join(roots.telegramRoot, `.${TELEGRAM_PROFILE_FILE_NAME}.write-1.tmp`),
      envelope,
      { mode: TELEGRAM_CREDENTIAL_FILE_MODE },
    );
    envelope.fill(0);

    const inventory = await scanCredentialEnvelopes(roots);

    expect(inventory.deletionBlockers).toHaveLength(1);
    expect(inventory.keychainDependents).toBe(1);
    expect(inventory.unverified).toBe(0);
  });

  posixIt("keeps unexplained entries separate from envelope recovery counts", async () => {
    const roots = await fixture();
    await mkdir(roots.credentialRoot, { recursive: true, mode: CREDENTIAL_DIRECTORY_MODE });
    await mkdir(roots.telegramRoot, { recursive: true, mode: TELEGRAM_CREDENTIAL_DIRECTORY_MODE });
    await writeFile(join(roots.credentialRoot, "future-credential-state"), "unexplained");
    await mkdir(join(roots.telegramRoot, "future-telegram-state"));
    const transport = transportOf();

    const inventory = await scanCredentialEnvelopes(roots);

    expect(inventory.deletionBlockers).toEqual([]);
    expect(inventory.unexplainedDeletionBlockers).toEqual([
      {
        vault: "credentials",
        root: roots.credentialRoot,
        fileName: "future-credential-state",
      },
      {
        vault: "telegram",
        root: roots.telegramRoot,
        fileName: "future-telegram-state",
      },
    ]);
    expect(inventory.keychainDependents).toBe(0);
    expect(inventory.unverified).toBe(0);
    await expect(retireKey(roots, transport)).resolves.toEqual({
      status: "retained",
      envelopes: 2,
    });
    expect(transport.requests).toHaveLength(0);
  });

  posixIt("exempts only exact bounded Telegram non-envelope vault state", async () => {
    const roots = await fixture();
    await mkdir(roots.telegramRoot, { recursive: true, mode: TELEGRAM_CREDENTIAL_DIRECTORY_MODE });
    await writeFile(join(roots.telegramRoot, TELEGRAM_DESIRED_STATE_FILE_NAME), "known-state", {
      mode: TELEGRAM_CREDENTIAL_FILE_MODE,
    });
    await writeFile(
      join(roots.telegramRoot, `.${TELEGRAM_DESIRED_STATE_FILE_NAME}.cleanup-1.deleted`),
      "known-transient",
      { mode: TELEGRAM_CREDENTIAL_FILE_MODE },
    );
    await writeFile(join(roots.telegramRoot, TELEGRAM_POWER_STATE_FILE_NAME), "known-power-state", {
      mode: TELEGRAM_CREDENTIAL_FILE_MODE,
    });
    await writeFile(
      join(roots.telegramRoot, `.${TELEGRAM_POWER_STATE_FILE_NAME}.cleanup-1.tmp`),
      "known-power-transient",
      { mode: TELEGRAM_CREDENTIAL_FILE_MODE },
    );
    const transport = transportOf({ ok: true, op: "delete-key", deleted: true });

    await expect(retireKey(roots, transport)).resolves.toEqual({ status: "deleted" });
  });

  posixIt("blocks unsafe and keychain-backed Telegram state lookalikes", async () => {
    const roots = await fixture();
    await mkdir(roots.telegramRoot, { recursive: true, mode: TELEGRAM_CREDENTIAL_DIRECTORY_MODE });
    await mkdir(join(roots.telegramRoot, TELEGRAM_DESIRED_STATE_FILE_NAME));
    const keychainEnvelope = sealCredentialEnvelope(
      randomBytes(KEYCHAIN_KEY_BYTES),
      "not-desired-state",
    );
    const transient = `.${TELEGRAM_DESIRED_STATE_FILE_NAME}.cleanup-1.tmp`;
    await writeFile(join(roots.telegramRoot, transient), keychainEnvelope, {
      mode: TELEGRAM_CREDENTIAL_FILE_MODE,
    });
    keychainEnvelope.fill(0);

    const inventory = await scanCredentialEnvelopes(roots);

    expect(inventory.deletionBlockers).toEqual([]);
    expect(inventory.unexplainedDeletionBlockers.map((entry) => entry.fileName)).toEqual([
      transient,
      TELEGRAM_DESIRED_STATE_FILE_NAME,
    ]);
    expect(inventory.keychainDependents).toBe(0);
    expect(inventory.unverified).toBe(0);
  });

  posixIt("blocks a keychain-backed Telegram power-state lookalike", async () => {
    const roots = await fixture();
    await mkdir(roots.telegramRoot, { recursive: true, mode: TELEGRAM_CREDENTIAL_DIRECTORY_MODE });
    const keychainEnvelope = sealCredentialEnvelope(
      randomBytes(KEYCHAIN_KEY_BYTES),
      "not-power-state",
    );
    await writeFile(join(roots.telegramRoot, TELEGRAM_POWER_STATE_FILE_NAME), keychainEnvelope, {
      mode: TELEGRAM_CREDENTIAL_FILE_MODE,
    });
    keychainEnvelope.fill(0);

    const inventory = await scanCredentialEnvelopes(roots);

    expect(inventory.deletionBlockers).toEqual([]);
    expect(inventory.unexplainedDeletionBlockers.map((entry) => entry.fileName)).toEqual([
      TELEGRAM_POWER_STATE_FILE_NAME,
    ]);
  });

  posixIt("reports an absent item and a refused delete apart", async () => {
    const roots = await fixture();

    await expect(
      retireKey(roots, transportOf({ ok: true, op: "delete-key", deleted: false })),
    ).resolves.toEqual({ status: "already-absent" });

    await expect(
      retireKey(roots, transportOf({ ok: false, code: "keychain-locked" })),
    ).resolves.toEqual({
      status: "failed",
      code: "keychain-locked",
      keyCleanupPending: true,
    });
  });
});
