import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CREDENTIAL_DIRECTORY_MODE,
  CREDENTIAL_FILE_MODE,
  createCredentialVault,
  markUnselectedModelCredentialsInactive,
  replaceCredentialRuntimeStates,
  type CredentialEncryptionPort,
} from "../src/main/credential-vault.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "desktop-vault-"));
  roots.push(root);
  return join(root, "credentials-v1");
}

function encryption(): CredentialEncryptionPort {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) =>
      Buffer.concat([Buffer.from("SAFE:"), Buffer.from(value).reverse(), Buffer.from(":END")]),
    decryptString(value) {
      if (
        !value.subarray(0, 5).equals(Buffer.from("SAFE:")) ||
        !value.subarray(-4).equals(Buffer.from(":END"))
      ) {
        throw new TypeError();
      }
      return value.subarray(5, -4).reverse().toString();
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("desktop credential vault", () => {
  it("refuses unavailable encryption and invalid input before filesystem work", async () => {
    const root = await temporaryRoot();
    const encryptString = vi.fn(() => Buffer.from("unused"));
    const vault = createCredentialVault({
      root,
      encryption: { isEncryptionAvailable: () => false, encryptString, decryptString: vi.fn() },
      applyCredential: vi.fn(),
    });
    await expect(vault.writeCredential({ slot: "anthropic", value: "synthetic" })).resolves.toEqual(
      {
        slot: "anthropic",
        status: "refused",
        reason: "encryption-unavailable",
      },
    );
    await expect(vault.writeCredential({ slot: "anthropic", value: "  " })).resolves.toEqual({
      slot: "anthropic",
      status: "refused",
      reason: "invalid-input",
    });
    await expect(
      vault.writeCredential({ slot: "unknown", value: "synthetic" } as never),
    ).resolves.toEqual({
      slot: "anthropic",
      status: "refused",
      reason: "invalid-input",
    });
    expect(encryptString).not.toHaveBeenCalled();
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts the macOS encryption shape and writes one atomic secure ciphertext", async () => {
    const root = await temporaryRoot();
    const sentinel = "desktop-sentinel-model-key";
    const applyCredential = vi.fn(async () => {
      const committed = await readFile(join(root, "anthropic.bin"));
      expect(committed.length).toBeGreaterThan(0);
      expect(committed.includes(Buffer.from(sentinel))).toBe(false);
      expect((await readdir(root)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    });
    const vault = createCredentialVault({ root, encryption: encryption(), applyCredential });
    await expect(
      vault.writeCredential({ slot: "anthropic", value: ` ${sentinel} ` }),
    ).resolves.toEqual({
      slot: "anthropic",
      status: "configured",
      runtimeReady: true,
    });
    const directory = await lstat(root);
    const path = join(root, "anthropic.bin");
    const file = await lstat(path);
    const ciphertext = await readFile(path);
    expect(directory.mode & 0o777).toBe(CREDENTIAL_DIRECTORY_MODE);
    expect(file.mode & 0o777).toBe(CREDENTIAL_FILE_MODE);
    expect(ciphertext.length).toBeGreaterThan(0);
    expect(ciphertext.includes(Buffer.from(sentinel))).toBe(false);
    expect(await readdir(root)).toEqual(["anthropic.bin"]);
    expect(applyCredential).toHaveBeenCalledWith("anthropic", sentinel);
    await expect(vault.credentialStatuses()).resolves.toContainEqual({
      slot: "anthropic",
      state: "configured",
      runtimeState: "active",
    });
  });

  it("fails closed for insecure directories and targets", async () => {
    const root = await temporaryRoot();
    await mkdir(root, { mode: 0o755 });
    const vault = createCredentialVault({
      root,
      encryption: encryption(),
      applyCredential: vi.fn(),
    });
    await expect(
      vault.writeCredential({ slot: "anthropic", value: "synthetic" }),
    ).resolves.toMatchObject({
      status: "refused",
      reason: "storage-failed",
    });
    await chmod(root, 0o700);
    await symlink(join(root, "missing"), join(root, "anthropic.bin"));
    await expect(
      vault.writeCredential({ slot: "anthropic", value: "synthetic" }),
    ).resolves.toMatchObject({
      status: "refused",
      reason: "storage-failed",
    });
    await rm(join(root, "anthropic.bin"));
    await writeFile(join(root, "anthropic.bin"), "", { mode: 0o600 });
    await expect(
      vault.writeCredential({ slot: "anthropic", value: "synthetic" }),
    ).resolves.toMatchObject({
      status: "refused",
      reason: "storage-failed",
    });
    await rm(join(root, "anthropic.bin"));
    await mkdir(join(root, "anthropic.bin"), { mode: 0o700 });
    await expect(
      vault.writeCredential({ slot: "anthropic", value: "synthetic" }),
    ).resolves.toMatchObject({
      status: "refused",
      reason: "storage-failed",
    });
    await rm(join(root, "anthropic.bin"), { recursive: true });
    await writeFile(join(root, "anthropic.bin"), "ciphertext", { mode: 0o644 });
    await expect(
      vault.writeCredential({ slot: "anthropic", value: "synthetic" }),
    ).resolves.toMatchObject({
      status: "refused",
      reason: "storage-failed",
    });
  });

  it("minimizes encryption backend failures without touching storage", async () => {
    const root = await temporaryRoot();
    const encryptString = vi.fn(() => Buffer.from("unused"));
    const vault = createCredentialVault({
      root,
      encryption: {
        isEncryptionAvailable: () => {
          throw new TypeError("synthetic backend detail");
        },
        encryptString,
        decryptString: vi.fn(),
      },
      applyCredential: vi.fn(),
    });
    await expect(
      vault.writeCredential({ slot: "anthropic", value: "synthetic-secret" }),
    ).resolves.toEqual({
      slot: "anthropic",
      status: "refused",
      reason: "encryption-unavailable",
    });
    expect(encryptString).not.toHaveBeenCalled();
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("isolates corruption and retries a committed runtime failure in main", async () => {
    const root = await temporaryRoot();
    let failRuntime = false;
    const applied: string[] = [];
    const vault = createCredentialVault({
      root,
      encryption: encryption(),
      async applyCredential(slot) {
        if (failRuntime) throw new TypeError();
        applied.push(slot);
      },
    });
    await vault.writeCredential({ slot: "anthropic", value: "synthetic-one" });
    await vault.writeCredential({ slot: "openrouter", value: "synthetic-two" });
    failRuntime = true;
    await expect(
      vault.writeCredential({ slot: "google", value: "synthetic-three" }),
    ).resolves.toEqual({
      slot: "google",
      status: "refused",
      reason: "runtime-unavailable",
    });
    expect((await lstat(join(root, "google.bin"))).isFile()).toBe(true);
    const corrupted = await readFile(join(root, "anthropic.bin"));
    corrupted[0] = corrupted[0]! ^ 0xff;
    await writeFile(join(root, "anthropic.bin"), corrupted, { mode: 0o600 });
    const statuses = await vault.credentialStatuses();
    expect(statuses).toContainEqual({ slot: "anthropic", state: "re-prompt", runtimeState: null });
    expect(statuses).toContainEqual({
      slot: "openrouter",
      state: "configured",
      runtimeState: "active",
    });
    expect(statuses).toContainEqual({
      slot: "google",
      state: "configured",
      runtimeState: "failed",
    });
    failRuntime = false;
    await vault.reapplyConfigured();
    expect(await vault.credentialStatuses()).toContainEqual({
      slot: "google",
      state: "configured",
      runtimeState: "active",
    });
    expect(applied).toContain("google");
  });

  it("routes passive replay separately from an explicit credential selection", async () => {
    const root = await temporaryRoot();
    const applyCredential = vi.fn(async () => {});
    const reapplyCredential = vi.fn(async () => "stored-inactive" as const);
    const vault = createCredentialVault({
      root,
      encryption: encryption(),
      applyCredential,
      reapplyCredential,
    });
    await vault.writeCredential({
      slot: "anthropic",
      value: String.fromCharCode(115, 121, 110, 116, 104, 101, 116, 105, 99),
    });
    expect(applyCredential).toHaveBeenCalledOnce();
    expect(reapplyCredential).not.toHaveBeenCalled();

    await vault.reapplyConfigured();

    expect(reapplyCredential).toHaveBeenCalledOnce();
    expect(await vault.credentialStatuses()).toContainEqual({
      slot: "anthropic",
      state: "configured",
      runtimeState: "stored-inactive",
    });
  });

  it("retries a failed credential through selection-aware replay", async () => {
    const root = await temporaryRoot();
    let runtimeAvailable = false;
    const applyCredential = vi.fn(async () => {
      if (!runtimeAvailable) throw new TypeError();
    });
    const reapplyCredential = vi.fn(async () => {
      if (!runtimeAvailable) throw new TypeError();
      return "active" as const;
    });
    const vault = createCredentialVault({
      root,
      encryption: encryption(),
      applyCredential,
      reapplyCredential,
    });
    await vault.writeCredential({ slot: "anthropic", value: randomUUID() });
    await expect(vault.credentialStatuses()).resolves.toContainEqual({
      slot: "anthropic",
      state: "configured",
      runtimeState: "failed",
    });
    await vault.reapplyConfigured();
    await expect(vault.credentialStatuses()).resolves.toContainEqual({
      slot: "anthropic",
      state: "configured",
      runtimeState: "failed",
    });
    runtimeAvailable = true;

    await vault.retryFailed();

    expect(reapplyCredential).toHaveBeenCalledTimes(2);
    expect(applyCredential).toHaveBeenCalledOnce();
    await expect(vault.credentialStatuses()).resolves.toContainEqual({
      slot: "anthropic",
      state: "configured",
      runtimeState: "active",
    });
  });

  it("fails closed when runtime publication becomes stale after apply, replay, or retry", async () => {
    const root = await temporaryRoot();
    let current = true;
    const vault = createCredentialVault({
      root,
      encryption: encryption(),
      createRuntimePublicationGuard: () => () => current,
      async applyCredential() {
        current = false;
      },
      async reapplyCredential() {
        current = false;
        return "active";
      },
    });

    await expect(
      vault.writeCredential({ slot: "anthropic", value: randomUUID() }),
    ).resolves.toMatchObject({
      status: "refused",
      reason: "runtime-unavailable",
    });
    current = true;
    await vault.reapplyConfigured();
    await expect(vault.credentialStatuses()).resolves.toContainEqual({
      slot: "anthropic",
      state: "configured",
      runtimeState: "failed",
    });
    current = true;
    await vault.retryFailed();
    await expect(vault.credentialStatuses()).resolves.toContainEqual({
      slot: "anthropic",
      state: "configured",
      runtimeState: "failed",
    });
  });

  it("refuses a stale failed retry after another provider becomes selected", async () => {
    const root = await temporaryRoot();
    let selectedProvider: "anthropic" | "openrouter" = "anthropic";
    const applyCredential = vi.fn(async () => {
      throw new TypeError();
    });
    const vault = createCredentialVault({
      root,
      encryption: encryption(),
      applyCredential,
      reapplyCredential: async (slot) => (slot === selectedProvider ? "active" : "stored-inactive"),
    });
    await vault.writeCredential({ slot: "anthropic", value: randomUUID() });
    await expect(vault.credentialStatuses()).resolves.toContainEqual({
      slot: "anthropic",
      state: "configured",
      runtimeState: "failed",
    });

    selectedProvider = "openrouter";
    await vault.retryFailed();
    expect(applyCredential).toHaveBeenCalledOnce();
    await expect(vault.credentialStatuses()).resolves.toContainEqual({
      slot: "anthropic",
      state: "configured",
      runtimeState: "stored-inactive",
    });
  });

  it("reports a deliberately skipped stored credential as inactive without retrying it", async () => {
    const root = await temporaryRoot();
    const applyCredential = vi.fn(async () => {});
    const reapplyCredential = vi.fn(async () => "stored-inactive" as const);
    const vault = createCredentialVault({
      root,
      encryption: encryption(),
      applyCredential,
      reapplyCredential,
    });
    await vault.writeCredential({ slot: "anthropic", value: randomUUID() });

    await vault.reapplyConfigured();

    await expect(vault.credentialStatuses()).resolves.toContainEqual({
      slot: "anthropic",
      state: "configured",
      runtimeState: "stored-inactive",
    });
    await vault.retryFailed();
    expect(applyCredential).toHaveBeenCalledOnce();
  });

  it("publishes successor replay failures into the long-lived retry state", async () => {
    const root = await temporaryRoot();
    const runtimeState = new Map();
    let applyCredentialCount = 0;
    const applyCredential = async (): Promise<void> => {
      applyCredentialCount += 1;
    };
    const vault = createCredentialVault({
      root,
      encryption: encryption(),
      runtimeState,
      applyCredential,
    });
    await vault.writeCredential({ slot: "anthropic", value: randomUUID() });

    const successor = createCredentialVault({
      root,
      encryption: encryption(),
      applyCredential: async () => {
        throw new TypeError();
      },
    });
    await successor.reapplyConfigured();
    replaceCredentialRuntimeStates(runtimeState, await successor.credentialStatuses());

    await expect(vault.credentialStatuses()).resolves.toContainEqual({
      slot: "anthropic",
      state: "configured",
      runtimeState: "failed",
    });
    await vault.retryFailed();
    expect(applyCredentialCount).toBe(2);
    await expect(vault.credentialStatuses()).resolves.toContainEqual({
      slot: "anthropic",
      state: "configured",
      runtimeState: "active",
    });
  });

  it("marks a concurrently changed slot failed instead of publishing stale successor state", () => {
    const runtimeState = new Map([["anthropic" as const, "active" as const]]);

    replaceCredentialRuntimeStates(
      runtimeState,
      [{ slot: "anthropic", state: "configured", runtimeState: "active" }],
      () => false,
    );

    expect(runtimeState.get("anthropic")).toBe("failed");
  });

  it("keeps only the selected model credential active", async () => {
    const root = await temporaryRoot();
    const vault = createCredentialVault({
      root,
      encryption: encryption(),
      applyCredential: async () => {},
    });

    await vault.writeCredential({ slot: "anthropic", value: randomUUID() });
    await vault.writeCredential({ slot: "openrouter", value: randomUUID() });

    await expect(vault.credentialStatuses()).resolves.toEqual(
      expect.arrayContaining([
        { slot: "anthropic", state: "configured", runtimeState: "stored-inactive" },
        { slot: "openrouter", state: "configured", runtimeState: "active" },
      ]),
    );
  });

  it("marks model credentials inactive when a profile becomes selected", () => {
    const runtimeState = new Map([
      ["anthropic" as const, "active" as const],
      ["openrouter" as const, "failed" as const],
      ["intervals-icu" as const, "active" as const],
    ]);

    markUnselectedModelCredentialsInactive(runtimeState, undefined);

    expect(runtimeState).toEqual(
      new Map([
        ["anthropic", "stored-inactive"],
        ["openrouter", "stored-inactive"],
        ["intervals-icu", "active"],
      ]),
    );
  });
});
