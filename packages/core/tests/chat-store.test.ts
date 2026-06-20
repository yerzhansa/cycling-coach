import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "../src/agent/chat-store.js";

// ESM module namespaces are non-configurable, so vi.spyOn cannot intercept a
// named fs import. Mock the module up front: appendFileSync is a spy that
// delegates to the real implementation (captured inside the factory so it is
// not itself the mock) unless a test flips throwState.shouldThrow. vi.hoisted
// makes the spy + flag available to the hoisted vi.mock factory.
const { appendFileSyncSpy, throwState } = vi.hoisted(() => ({
  appendFileSyncSpy: vi.fn(),
  throwState: { shouldThrow: null as (() => never) | null },
}));
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const realAppend = actual.appendFileSync;
  appendFileSyncSpy.mockImplementation((path: string, data: string, opts?: unknown) => {
    if (throwState.shouldThrow) throwState.shouldThrow();
    return realAppend(path, data, opts as Parameters<typeof realAppend>[2]);
  });
  return { ...actual, appendFileSync: (...args: [string, string, unknown?]) => appendFileSyncSpy(...args) };
});

let dataDir: string;
let sessionsDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cc-chat-store-"));
  sessionsDir = join(dataDir, "sessions");
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  throwState.shouldThrow = null;
  appendFileSyncSpy.mockClear();
});

const LINEAGE = { templateHash: "t", assembledHash: "h", provider: "p", model: "m" };

function listArchives(chatId: string): string[] {
  return readdirSync(sessionsDir)
    .filter((f) => f.startsWith(`${chatId}.jsonl.reset.`))
    .sort();
}

function listPrecompactArchives(chatId: string): string[] {
  return readdirSync(sessionsDir)
    .filter((f) => f.startsWith(`${chatId}.jsonl.precompact.`))
    .sort();
}

const MS_PER_DAY = 86_400_000;

function plantArchive(chatId: string, date: Date, suffix = "reset"): string {
  const name = `${chatId}.jsonl.${suffix}.${date.toISOString().replace(/:/g, "-")}`;
  writeFileSync(join(sessionsDir, name), "{}\n", "utf-8");
  return name;
}

describe("ChatStore — on-disk permissions", () => {
  it("creates the sessions directory with owner-only 0o700", () => {
    new ChatStore(dataDir);

    expect(statSync(sessionsDir).mode & 0o777).toBe(0o700);
  });

  it("appendMessage creates the session file with owner-only 0o600", () => {
    const store = new ChatStore(dataDir);
    store.appendMessage("123", "user", "How was my HRV this week?");

    expect(statSync(join(sessionsDir, "123.jsonl")).mode & 0o777).toBe(0o600);
  });

  it("overwriteHistory writes the session file with owner-only 0o600", () => {
    const store = new ChatStore(dataDir);
    store.appendMessage("123", "user", "hello");
    store.overwriteHistory("123", [{ role: "assistant", content: "compacted" }]);

    expect(statSync(join(sessionsDir, "123.jsonl")).mode & 0o777).toBe(0o600);
  });
});

describe("ChatStore.archiveAndReset — archive retention", () => {
  it("archives the live session exactly once and clears it", () => {
    const store = new ChatStore(dataDir);
    store.appendMessage("123", "user", "hello");

    store.archiveAndReset("123");

    expect(store.hasSession("123")).toBe(false);
    expect(listArchives("123")).toHaveLength(1);
  });

  it("keeps every archive by default — count-based pruning is gone", () => {
    const store = new ChatStore(dataDir);
    const planted = Array.from({ length: 25 }, (_, i) => {
      const name = `123.jsonl.reset.2026-06-01T00-00-${String(i).padStart(2, "0")}.000Z`;
      writeFileSync(join(sessionsDir, name), "{}\n", "utf-8");
      return name;
    });

    store.appendMessage("123", "user", "hello");
    store.archiveAndReset("123");

    const archives = listArchives("123");
    expect(archives).toHaveLength(26);
    for (const kept of planted) {
      expect(archives).toContain(kept);
    }
  });

  it("is a no-op when no live session exists", () => {
    const store = new ChatStore(dataDir);

    store.archiveAndReset("123");

    expect(existsSync(join(sessionsDir, "123.jsonl"))).toBe(false);
    expect(listArchives("123")).toHaveLength(0);
  });
});

describe("ChatStore.archiveAndReset — opt-in age-based retention", () => {
  it("deletes archives older than the horizon and keeps newer ones", () => {
    const store = new ChatStore(dataDir, 365);
    const old = plantArchive("123", new Date(Date.now() - 366 * MS_PER_DAY));
    const recent = plantArchive("123", new Date(Date.now() - 1 * MS_PER_DAY));

    store.appendMessage("123", "user", "hello");
    store.archiveAndReset("123");

    const archives = listArchives("123");
    expect(archives).not.toContain(old);
    expect(archives).toContain(recent);
    expect(archives).toHaveLength(2);
  });

  it("never deletes an archive whose timestamp suffix cannot be parsed", () => {
    const store = new ChatStore(dataDir, 1);
    const odd = "123.jsonl.reset.not-a-timestamp";
    writeFileSync(join(sessionsDir, odd), "{}\n", "utf-8");

    store.appendMessage("123", "user", "hello");
    store.archiveAndReset("123");

    expect(listArchives("123")).toContain(odd);
  });

  it("prunes only the resetting chat's archives", () => {
    const store = new ChatStore(dataDir, 1);
    const otherOld = plantArchive("456", new Date(Date.now() - 400 * MS_PER_DAY));

    store.appendMessage("123", "user", "hello");
    store.archiveAndReset("123");

    expect(listArchives("456")).toContain(otherOld);
  });

  it("does not prune even ancient archives when retention is disabled", () => {
    const store = new ChatStore(dataDir);
    const ancient = plantArchive("123", new Date(Date.now() - 4000 * MS_PER_DAY));

    store.appendMessage("123", "user", "hello");
    store.archiveAndReset("123");

    expect(listArchives("123")).toContain(ancient);
  });
});

describe("ChatStore.archivePreCompact — pre-compaction archives", () => {
  it("copies the session file, leaving the original intact", () => {
    const store = new ChatStore(dataDir);
    store.appendMessage("123", "user", "precious context");

    store.archivePreCompact("123");

    expect(store.hasSession("123")).toBe(true);
    expect(readFileSync(join(sessionsDir, "123.jsonl"), "utf-8")).toContain("precious context");
    const archives = listPrecompactArchives("123");
    expect(archives).toHaveLength(1);
    expect(readFileSync(join(sessionsDir, archives[0]), "utf-8")).toContain("precious context");
  });

  it("writes the archive with owner-only 0o600", () => {
    const store = new ChatStore(dataDir);
    store.appendMessage("123", "user", "precious context");

    store.archivePreCompact("123");

    const archives = listPrecompactArchives("123");
    expect(statSync(join(sessionsDir, archives[0])).mode & 0o777).toBe(0o600);
  });

  it("is a no-op when no live session exists", () => {
    const store = new ChatStore(dataDir);

    store.archivePreCompact("ghost");

    expect(existsSync(join(sessionsDir, "ghost.jsonl"))).toBe(false);
    expect(listPrecompactArchives("ghost")).toHaveLength(0);
  });

  it("never prunes pre-compaction archives when retention is disabled", () => {
    const store = new ChatStore(dataDir);
    const old = plantArchive("123", new Date(Date.now() - 40 * MS_PER_DAY), "precompact");

    store.appendMessage("123", "user", "hello");
    store.archivePreCompact("123");

    expect(listPrecompactArchives("123")).toContain(old);
  });

  it("prunes only its own suffix when opt-in retention is active", () => {
    const store = new ChatStore(dataDir, 30);
    const oldPrecompact = plantArchive("123", new Date(Date.now() - 40 * MS_PER_DAY), "precompact");
    const oldReset = plantArchive("123", new Date(Date.now() - 40 * MS_PER_DAY), "reset");

    store.appendMessage("123", "user", "hello");
    store.archivePreCompact("123");

    expect(listPrecompactArchives("123")).not.toContain(oldPrecompact);
    expect(listPrecompactArchives("123")).toHaveLength(1);
    expect(listArchives("123")).toContain(oldReset);

    store.archiveAndReset("123");

    expect(listArchives("123")).not.toContain(oldReset);
    expect(listPrecompactArchives("123")).toHaveLength(1);
  });
});

describe("ChatStore.appendTurn — single-buffer atomic two-line append", () => {
  it("issues exactly one appendFileSync writing both the user and assistant line", () => {
    const store = new ChatStore(dataDir);
    appendFileSyncSpy.mockClear();

    store.appendTurn("c1", "u", "a", LINEAGE);

    // The ChatStore constructor's mkdir does not append, so the only append in
    // this turn is appendTurn's single write.
    expect(appendFileSyncSpy).toHaveBeenCalledTimes(1);
    const buffer = appendFileSyncSpy.mock.calls[0][1] as string;
    expect(buffer).toContain('"role":"user"');
    expect(buffer).toContain('"role":"assistant"');

    const { messages } = store.load("c1");
    expect(messages).toEqual([
      { role: "user", content: "u" },
      { role: "assistant", content: "a" },
    ]);
  });

  it("throws on an fs error and leaves no dangling user line", () => {
    const store = new ChatStore(dataDir);
    throwState.shouldThrow = () => {
      throw Object.assign(new Error("ENOSPC: no space left"), { code: "ENOSPC" });
    };

    expect(() => store.appendTurn("c1", "u", "a", LINEAGE)).toThrow();

    throwState.shouldThrow = null;
    expect(existsSync(join(sessionsDir, "c1.jsonl"))).toBe(false);
    expect(store.load("c1").messages).toEqual([]);
  });
});
