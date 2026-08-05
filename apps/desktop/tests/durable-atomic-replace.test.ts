import { mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  durableAtomicReplace,
  durablyReplaceReversible,
} from "../src/main/durable-atomic-replace.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "enduragent-durable-replace-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable atomic replace", () => {
  it("enforces the requested mode before syncing and publishing the candidate", async () => {
    const root = await temporaryRoot();
    const target = join(root, "setting.json");

    const result = await durableAtomicReplace({
      root,
      fileName: "setting.json",
      contents: "candidate",
      mode: 0o600,
      createId: () => "restrictive-creation-mode",
      openFile: ((path, flags) => open(path, flags, 0o000)) as typeof open,
    });

    expect(result).toEqual({ state: "durably-committed" });
    expect((await stat(target)).mode & 0o777).toBe(0o600);
  });

  it("reports not committed when temporary creation fails", async () => {
    const root = await temporaryRoot();
    const target = join(root, "setting.json");
    await writeFile(target, "old", { mode: 0o600 });
    const removeFile = vi.fn(async () => undefined);

    const result = await durableAtomicReplace({
      root,
      fileName: "setting.json",
      contents: "candidate",
      mode: 0o600,
      createId: () => "create-failure",
      openFile: vi.fn(async () => {
        throw new TypeError("synthetic temporary create failure");
      }) as never,
      removeFile: removeFile as never,
    });

    expect(result).toEqual({ state: "not-committed" });
    await expect(readFile(target, "utf8")).resolves.toBe("old");
    expect(removeFile).toHaveBeenCalledWith(join(root, ".setting.json.create-failure.tmp"), {
      force: true,
    });
  });

  it("reports not committed when writing the temporary file fails", async () => {
    const root = await temporaryRoot();
    const target = join(root, "setting.json");
    await writeFile(target, "old", { mode: 0o600 });
    const sync = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);

    const result = await durableAtomicReplace({
      root,
      fileName: "setting.json",
      contents: "candidate",
      mode: 0o600,
      createId: () => "write-failure",
      openFile: vi.fn(async () => ({
        writeFile: async () => {
          throw new TypeError("synthetic temporary write failure");
        },
        sync,
        close,
      })) as never,
    });

    expect(result).toEqual({ state: "not-committed" });
    await expect(readFile(target, "utf8")).resolves.toBe("old");
    expect(sync).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("reports not committed when syncing the temporary file fails", async () => {
    const root = await temporaryRoot();
    const target = join(root, "setting.json");
    await writeFile(target, "old", { mode: 0o600 });
    const close = vi.fn(async () => undefined);
    const sync = vi.fn(async () => {
      throw new TypeError("synthetic temporary file sync failure");
    });

    const result = await durableAtomicReplace({
      root,
      fileName: "setting.json",
      contents: "candidate",
      mode: 0o600,
      createId: () => "file-sync-failure",
      openFile: vi.fn(async () => ({
        writeFile: async () => undefined,
        chmod: async () => undefined,
        sync,
        close,
      })) as never,
    });

    expect(result).toEqual({ state: "not-committed" });
    await expect(readFile(target, "utf8")).resolves.toBe("old");
    expect(sync).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps a pre-rename refusal truthful when temporary cleanup also fails", async () => {
    const root = await temporaryRoot();
    const target = join(root, "setting.json");
    const temporary = join(root, ".setting.json.cleanup-failure.tmp");
    await writeFile(target, "old", { mode: 0o600 });
    const removeFile = vi.fn(async () => {
      throw new TypeError("synthetic temporary cleanup failure");
    });

    const result = await durableAtomicReplace({
      root,
      fileName: "setting.json",
      contents: "candidate",
      mode: 0o600,
      createId: () => "cleanup-failure",
      renameFile: async () => {
        throw new TypeError("synthetic rename failure");
      },
      removeFile: removeFile as never,
    });

    expect(result).toEqual({ state: "not-committed" });
    await expect(readFile(target, "utf8")).resolves.toBe("old");
    await expect(readFile(temporary, "utf8")).resolves.toBe("candidate");
    expect(removeFile).toHaveBeenCalledWith(temporary, { force: true });
  });

  it("reports commit uncertainty when rename published the candidate but directory sync failed", async () => {
    const root = await temporaryRoot();
    const target = join(root, "setting.json");
    await writeFile(target, "old", { mode: 0o600 });

    const result = await durableAtomicReplace({
      root,
      fileName: "setting.json",
      contents: Buffer.from("candidate"),
      mode: 0o600,
      createId: () => "uncertain",
      syncDirectory: async () => {
        throw new TypeError("synthetic directory sync failure");
      },
    });

    expect(result).toEqual({ state: "commit-uncertain" });
    await expect(readFile(target, "utf8")).resolves.toBe("candidate");
    const directory = await open(root, "r");
    await directory.close();
  });

  it("distinguishes pre-rename refusal from a durable replacement", async () => {
    const root = await temporaryRoot();
    const target = join(root, "setting.json");
    await writeFile(target, "old", { mode: 0o600 });
    const refused = await durableAtomicReplace({
      root,
      fileName: "setting.json",
      contents: "candidate",
      mode: 0o600,
      createId: () => "refused",
      renameFile: async () => {
        throw new TypeError("synthetic rename failure");
      },
    });
    expect(refused).toEqual({ state: "not-committed" });
    await expect(readFile(target, "utf8")).resolves.toBe("old");

    const committed = await durableAtomicReplace({
      root,
      fileName: "setting.json",
      contents: "candidate",
      mode: 0o600,
      createId: () => "committed",
    });
    expect(committed).toEqual({ state: "durably-committed" });
    await expect(readFile(target, "utf8")).resolves.toBe("candidate");
  });

  it("does not retroactively change a durable result when directory descriptor cleanup fails", async () => {
    const root = await temporaryRoot();
    const close = vi.fn(async () => {
      throw new TypeError("synthetic close failure");
    });
    const result = await durableAtomicReplace({
      root,
      fileName: "setting.json",
      contents: "candidate",
      mode: 0o600,
      createId: () => "close-failure",
      openDirectory: vi.fn(async () => ({ sync: async () => {}, close })) as never,
    });

    expect(result).toEqual({ state: "durably-committed" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("durably restores the prior bytes before refusing an uncertain replacement", async () => {
    const root = await temporaryRoot();
    const target = join(root, "setting.json");
    const prior = Buffer.from("old");
    const candidate = Buffer.from("candidate");
    await writeFile(target, prior, { mode: 0o600 });
    let syncCount = 0;

    const result = await durablyReplaceReversible({
      root,
      fileName: "setting.json",
      contents: candidate,
      previousContents: prior,
      mode: 0o600,
      createId: () => `attempt-${syncCount}`,
      renameFile: rename,
      syncDirectory: async () => {
        syncCount += 1;
        if (syncCount === 1) throw new TypeError("synthetic first directory sync failure");
        const directory = await open(root, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      },
    });

    expect(result).toEqual({ state: "refused" });
    await expect(readFile(target, "utf8")).resolves.toBe("old");
  });

  it("returns uncertainty without requesting a second id after the candidate became visible", async () => {
    const root = await temporaryRoot();
    const target = join(root, "setting.json");
    await writeFile(target, "old", { mode: 0o600 });
    let idCalls = 0;

    const result = await durablyReplaceReversible({
      root,
      fileName: "setting.json",
      contents: "candidate",
      previousContents: Buffer.from("old"),
      mode: 0o600,
      createId: () => {
        idCalls += 1;
        if (idCalls === 1) return "initial";
        throw new TypeError("synthetic compensation id failure");
      },
      syncDirectory: async () => {
        throw new TypeError("synthetic directory sync failure");
      },
    });

    expect(result).toEqual({ state: "uncertain" });
    expect(["old", "candidate"]).toContain(await readFile(target, "utf8"));
    expect(idCalls).toBe(1);
  });

  it("reuses one operation id so first-write convergence cleans its original tombstone", async () => {
    const root = await temporaryRoot();
    const target = join(root, "setting.json");
    let syncCount = 0;
    let idCount = 0;

    const result = await durablyReplaceReversible({
      root,
      fileName: "setting.json",
      contents: "candidate",
      previousContents: undefined,
      mode: 0o600,
      createId: () => `operation-${++idCount}`,
      syncDirectory: async () => {
        syncCount += 1;
        if (syncCount <= 2) throw new TypeError("synthetic directory sync failure");
      },
    });

    expect(result).toEqual({ state: "refused" });
    await expect(readFile(target, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(root)).filter((entry) => entry.endsWith(".deleted"))).toEqual([]);
    expect(idCount).toBe(1);
  });
});
