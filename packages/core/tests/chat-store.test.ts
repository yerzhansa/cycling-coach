import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveAndResetDurably, ChatStore } from "../src/agent/chat-store.js";

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
  return {
    ...actual,
    appendFileSync: (...args: [string, string, unknown?]) => appendFileSyncSpy(...args),
  };
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

const LINEAGE = {
  templateHash: "t",
  assembledHash: "h",
  provider: "p",
  model: "m",
  lineageVersion: "1",
};
const DURABLE_RESET = {
  resetId: "d".repeat(64),
  boundaryAt: "2026-07-22T01:02:03.000Z",
};

function durableArchivePath(chatId: string): string {
  return join(
    sessionsDir,
    `${chatId}.jsonl.reset.${DURABLE_RESET.boundaryAt.replace(/:/g, "-")}.${DURABLE_RESET.resetId}`,
  );
}

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

  it("refuses a pre-existing permissive sessions directory without repairing it", () => {
    mkdirSync(sessionsDir, { mode: 0o755 });
    chmodSync(sessionsDir, 0o755);

    expect(() => new ChatStore(dataDir)).toThrow("Sessions directory is unsafe.");
    expect(lstatSync(sessionsDir).mode & 0o7777).toBe(0o755);
  });
});

describe("ChatStore durable reset — private race-checked targets", () => {
  it("archives one exact 0600 session from an exact 0700 directory without changing bytes", () => {
    const store = new ChatStore(dataDir);
    store.appendTurn("safe", "synthetic user", "synthetic assistant", LINEAGE);
    const active = join(sessionsDir, "safe.jsonl");
    const before = readFileSync(active);

    archiveAndResetDurably(store, "safe", DURABLE_RESET);

    const archive = durableArchivePath("safe");
    expect(existsSync(active)).toBe(false);
    expect(readFileSync(archive)).toEqual(before);
    expect(lstatSync(sessionsDir).mode & 0o7777).toBe(0o700);
    expect(lstatSync(archive).mode & 0o7777).toBe(0o600);
    expect(lstatSync(archive).nlink).toBe(1);
  });

  it("refuses a permissive active file without chmodding or archiving it", () => {
    const store = new ChatStore(dataDir);
    store.appendTurn("permissive", "synthetic user", "synthetic assistant", LINEAGE);
    const active = join(sessionsDir, "permissive.jsonl");
    const before = readFileSync(active);
    chmodSync(active, 0o644);

    expect(() => archiveAndResetDurably(store, "permissive", DURABLE_RESET)).toThrow(
      "Active reset session target is unsafe.",
    );
    expect(readFileSync(active)).toEqual(before);
    expect(lstatSync(active).mode & 0o7777).toBe(0o644);
    expect(existsSync(durableArchivePath("permissive"))).toBe(false);
  });

  it("refuses symbolic and non-regular active reset targets", () => {
    const store = new ChatStore(dataDir);
    const outside = join(dataDir, "synthetic-outside.jsonl");
    writeFileSync(outside, "synthetic outside\n", { mode: 0o600 });
    symlinkSync(outside, join(sessionsDir, "symbolic.jsonl"));
    mkdirSync(join(sessionsDir, "non-regular.jsonl"), { mode: 0o700 });

    expect(() => archiveAndResetDurably(store, "symbolic", DURABLE_RESET)).toThrow(
      "Active reset session target is unsafe.",
    );
    expect(() => archiveAndResetDurably(store, "non-regular", DURABLE_RESET)).toThrow(
      "Active reset session target is unsafe.",
    );
    expect(readFileSync(outside, "utf8")).toBe("synthetic outside\n");
    expect(lstatSync(join(sessionsDir, "symbolic.jsonl")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(sessionsDir, "non-regular.jsonl")).isDirectory()).toBe(true);
  });

  it("refuses an unexpected active link count", () => {
    const store = new ChatStore(dataDir);
    const active = join(sessionsDir, "linked.jsonl");
    writeFileSync(active, "synthetic linked session\n", { mode: 0o600 });
    linkSync(active, join(dataDir, "synthetic-shared-session.jsonl"));

    expect(() => archiveAndResetDurably(store, "linked", DURABLE_RESET)).toThrow(
      "Active reset session target is unsafe.",
    );
    expect(lstatSync(active).nlink).toBe(2);
    expect(existsSync(durableArchivePath("linked"))).toBe(false);
  });

  it("refuses a permissive completed archive without repairing it", () => {
    const store = new ChatStore(dataDir);
    const archive = durableArchivePath("archive-mode");
    writeFileSync(archive, "synthetic archive\n", { mode: 0o644 });
    chmodSync(archive, 0o644);

    expect(() => archiveAndResetDurably(store, "archive-mode", DURABLE_RESET)).toThrow(
      "Reset archive target is unsafe.",
    );
    expect(lstatSync(archive).mode & 0o7777).toBe(0o644);
  });

  it("rechecks sessions directory mode and identity before durable reset", () => {
    const modeStore = new ChatStore(dataDir);
    modeStore.appendTurn("mode-drift", "synthetic user", "synthetic assistant", LINEAGE);
    chmodSync(sessionsDir, 0o755);

    expect(() => archiveAndResetDurably(modeStore, "mode-drift", DURABLE_RESET)).toThrow(
      "Sessions directory is unsafe.",
    );
    expect(existsSync(join(sessionsDir, "mode-drift.jsonl"))).toBe(true);

    chmodSync(sessionsDir, 0o700);
    const identityStore = new ChatStore(dataDir);
    identityStore.appendTurn("identity-drift", "synthetic user", "synthetic assistant", LINEAGE);
    renameSync(sessionsDir, `${sessionsDir}.original`);
    mkdirSync(sessionsDir, { mode: 0o700 });

    expect(() => archiveAndResetDurably(identityStore, "identity-drift", DURABLE_RESET)).toThrow(
      "Sessions directory is unsafe.",
    );
    expect(existsSync(join(`${sessionsDir}.original`, "identity-drift.jsonl"))).toBe(true);
    expect(readdirSync(sessionsDir)).toEqual([]);
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

describe("ChatStore — empty assistant guard", () => {
  function assistantCount(store: ChatStore, chatId: string): number {
    return store.load(chatId).messages.filter((m) => m.role === "assistant").length;
  }

  it("appendTurn with empty assistant content writes no assistant line", () => {
    const store = new ChatStore(dataDir);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    store.appendTurn("g", "user text", "", LINEAGE);
    expect(assistantCount(store, "g")).toBe(0);
  });

  it("appendTurn with whitespace-only assistant content is treated as empty", () => {
    const store = new ChatStore(dataDir);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    store.appendTurn("g", "user text", "   \n  ", LINEAGE);
    expect(assistantCount(store, "g")).toBe(0);
  });

  it("appendTurn with real assistant content persists normally", () => {
    const store = new ChatStore(dataDir);
    store.appendTurn("g2", "u", "real reply", LINEAGE);
    const assistants = store.load("g2").messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0].content).toBe("real reply");
  });

  it('appendMessage("assistant", "") writes nothing', () => {
    const store = new ChatStore(dataDir);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    store.appendMessage("g3", "assistant", "");
    expect(assistantCount(store, "g3")).toBe(0);
  });
});
