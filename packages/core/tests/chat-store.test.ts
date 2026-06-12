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

const MS_PER_DAY = 86_400_000;

function plantArchive(chatId: string, date: Date): string {
  const name = `${chatId}.jsonl.reset.${date.toISOString().replace(/:/g, "-")}`;
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
