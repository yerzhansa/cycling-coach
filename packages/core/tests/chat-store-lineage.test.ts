import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ChatStore } from "../src/agent/chat-store.js";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dataDir: string;
let sessionsDir: string;
let store: ChatStore;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cc-lineage-"));
  sessionsDir = join(dataDir, "sessions");
  store = new ChatStore(dataDir);
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function readLines(chatId: string): Record<string, unknown>[] {
  return readFileSync(join(sessionsDir, `${chatId}.jsonl`), "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("ChatStore lineage", () => {
  it("writes the four lineage fields on an assistant line", () => {
    store.appendMessage("c1", "assistant", "reply", {
      templateHash: "0123456789abcdef",
      assembledHash: "fedcba9876543210",
      provider: "anthropic",
      model: "claude-x",
    });
    const [line] = readLines("c1");
    expect(line.role).toBe("assistant");
    expect(line.content).toBe("reply");
    expect(line.templateHash).toBe("0123456789abcdef");
    expect(line.assembledHash).toBe("fedcba9876543210");
    expect(line.provider).toBe("anthropic");
    expect(line.model).toBe("claude-x");
    expect(typeof line.ts).toBe("string");
  });

  it("writes no lineage on a user line", () => {
    store.appendMessage("c1", "user", "hi");
    const [line] = readLines("c1");
    expect(line.role).toBe("user");
    expect(line.content).toBe("hi");
    expect(typeof line.ts).toBe("string");
    expect("templateHash" in line).toBe(false);
    expect("provider" in line).toBe(false);
  });

  it("round-trips a session containing a lineage-bearing assistant line", () => {
    store.appendMessage("c1", "user", "hi");
    store.appendMessage("c1", "assistant", "reply", {
      templateHash: "0123456789abcdef",
      assembledHash: "fedcba9876543210",
      provider: "anthropic",
      model: "claude-x",
    });
    const { messages } = store.load("c1");
    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual({ role: "assistant", content: "reply" });
  });

  it("accepts an old session written without lineage fields", () => {
    writeFileSync(
      join(sessionsDir, "legacy.jsonl"),
      JSON.stringify({ role: "assistant", content: "old reply", ts: "2026-06-14T00:00:00.000Z" }) + "\n",
      { encoding: "utf-8", mode: 0o600 },
    );
    const { messages } = store.load("legacy");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ role: "assistant", content: "old reply" });
  });
});
