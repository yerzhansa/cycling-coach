import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "../src/agent/chat-store.js";

let dataDir: string;
let sessionsDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cc-chat-store-"));
  sessionsDir = join(dataDir, "sessions");
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function listArchives(chatId: string): string[] {
  return readdirSync(sessionsDir)
    .filter((f) => f.startsWith(`${chatId}.jsonl.reset.`))
    .sort();
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

  it("keeps at most 20 archives per chat, deleting the oldest first", () => {
    const store = new ChatStore(dataDir);
    // archiveAndReset timestamps have millisecond resolution, so rapid
    // looped resets would collide on one archive name; plant distinct
    // pre-existing archives directly instead.
    const planted = Array.from({ length: 25 }, (_, i) => {
      const name = `123.jsonl.reset.2026-06-01T00-00-${String(i).padStart(2, "0")}.000Z`;
      writeFileSync(join(sessionsDir, name), "{}\n", "utf-8");
      return name;
    });

    store.appendMessage("123", "user", "hello");
    store.archiveAndReset("123");

    const archives = listArchives("123");
    expect(archives).toHaveLength(20);
    // The 6 oldest planted archives are gone (25 planted + 1 new = 26 → 20).
    for (const stale of planted.slice(0, 6)) {
      expect(archives).not.toContain(stale);
    }
    // The newest planted archives and the fresh one survive.
    for (const kept of planted.slice(6)) {
      expect(archives).toContain(kept);
    }
  });

  it("prunes only the resetting chat's archives, not other chats'", () => {
    const store = new ChatStore(dataDir);
    for (let i = 0; i < 25; i++) {
      const suffix = `2026-06-01T00-00-${String(i).padStart(2, "0")}.000Z`;
      writeFileSync(join(sessionsDir, `456.jsonl.reset.${suffix}`), "{}\n", "utf-8");
    }

    store.appendMessage("123", "user", "hello");
    store.archiveAndReset("123");

    expect(listArchives("456")).toHaveLength(25);
    expect(listArchives("123")).toHaveLength(1);
  });

  it("is a no-op when no live session exists", () => {
    const store = new ChatStore(dataDir);

    store.archiveAndReset("123");

    expect(existsSync(join(sessionsDir, "123.jsonl"))).toBe(false);
    expect(listArchives("123")).toHaveLength(0);
  });
});
