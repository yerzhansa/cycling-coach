import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCredentialEnvelopeMutationLock } from "../src/main/credential-envelope-lock.js";
import { credentialEnvelopeTargets } from "../src/main/credential-envelope-inventory.js";
import { resetEncryptedCredentialStorage } from "../src/main/credential-reset.js";
import { TELEGRAM_PROFILE_FILE_NAME } from "../src/main/telegram-credential-vault.js";

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "credential-reset-"));
  roots.push(root);
  const credentialRoot = join(root, "credentials-v1");
  const telegramRoot = join(root, "telegram-channel-v1");
  await mkdir(credentialRoot, { recursive: true });
  await mkdir(telegramRoot, { recursive: true });
  return { credentialRoot, telegramRoot };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("encrypted credential reset", () => {
  it("removes every envelope under one shared lock and preserves unrelated files", async () => {
    const storage = await fixture();
    for (const target of credentialEnvelopeTargets(storage)) {
      await writeFile(join(target.root, target.fileName), Buffer.from("synthetic-envelope"));
    }
    const unrelated = join(storage.credentialRoot, "keep.txt");
    const credentialTemporary = join(storage.credentialRoot, ".anthropic.bin.reset-1.tmp");
    const telegramTombstone = join(
      storage.telegramRoot,
      `.${TELEGRAM_PROFILE_FILE_NAME}.reset-2.deleted`,
    );
    const unrelatedTemporary = join(storage.credentialRoot, ".unknown.bin.reset-3.tmp");
    await writeFile(unrelated, "keep");
    await writeFile(credentialTemporary, "credential-transient");
    await writeFile(telegramTombstone, "telegram-transient");
    await writeFile(unrelatedTemporary, "unrelated-transient");
    const deleteKey = vi.fn(async () => ({ status: "deleted" as const }));

    const result = await resetEncryptedCredentialStorage({
      ...storage,
      serializeEnvelopeMutation: createCredentialEnvelopeMutationLock(),
      deleteKey,
    });

    expect(result).toEqual({ status: "reset", keyCleanupPending: false });
    expect(deleteKey).toHaveBeenCalledOnce();
    await expect(readFile(unrelated, "utf8")).resolves.toBe("keep");
    await expect(readFile(unrelatedTemporary, "utf8")).resolves.toBe("unrelated-transient");
    await expect(readFile(credentialTemporary)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(telegramTombstone)).rejects.toMatchObject({ code: "ENOENT" });
    for (const target of credentialEnvelopeTargets(storage)) {
      await expect(readFile(join(target.root, target.fileName))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });

  it("does not delete the shared key while any envelope survives", async () => {
    const storage = await fixture();
    const target = credentialEnvelopeTargets(storage)[0]!;
    await writeFile(join(target.root, target.fileName), Buffer.from("synthetic-envelope"));
    const deleteKey = vi.fn(async () => ({ status: "deleted" as const }));

    const result = await resetEncryptedCredentialStorage({
      ...storage,
      serializeEnvelopeMutation: createCredentialEnvelopeMutationLock(),
      deleteKey,
      removeFile: vi.fn(async () => {
        throw new Error("synthetic removal failure");
      }) as never,
    });

    expect(result).toEqual({ status: "failed" });
    expect(deleteKey).not.toHaveBeenCalled();
  });

  it("reports deferred key cleanup after every envelope is gone", async () => {
    const storage = await fixture();

    const result = await resetEncryptedCredentialStorage({
      ...storage,
      serializeEnvelopeMutation: createCredentialEnvelopeMutationLock(),
      deleteKey: async () => ({ status: "failed", code: "keychain-locked" }),
    });

    expect(result).toEqual({ status: "reset", keyCleanupPending: true });
  });
});
