import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import {
  splitHistoryByBudget,
  makeSummaryMessage,
  SUMMARY_PREFIX,
} from "../src/agent/history-limit.js";
import { ChatStore } from "../src/agent/chat-store.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cc-histlimit-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const msg = (chars: number): ModelMessage => ({ role: "user", content: "x".repeat(chars) });

describe("splitHistoryByBudget", () => {
  it("returns empty kept/dropped and no summary for empty input", () => {
    expect(splitHistoryByBudget({ messages: [], tokenBudget: 100 })).toEqual({
      kept: [],
      dropped: [],
      previousSummary: undefined,
    });
  });

  it("extracts a summary at index 0 byte-exactly, including multi-line text", () => {
    const text = "line one\nline two";
    const result = splitHistoryByBudget({
      messages: [makeSummaryMessage(text), { role: "user", content: "hello" }],
      tokenBudget: 100_000,
    });
    expect(result.previousSummary).toBe(text);
    expect(result.kept).toEqual([{ role: "user", content: "hello" }]);
    expect(result.dropped).toEqual([]);
  });

  it("treats non-summary first messages as conversation, not summary", () => {
    const systemRoleWrongPrefix = splitHistoryByBudget({
      messages: [
        { role: "system", content: "You are a coach" },
        { role: "user", content: "hi" },
      ],
      tokenBudget: 100_000,
    });
    expect(systemRoleWrongPrefix.previousSummary).toBe(undefined);
    expect(systemRoleWrongPrefix.kept[0]).toEqual({ role: "system", content: "You are a coach" });

    const rightPrefixWrongRole = splitHistoryByBudget({
      messages: [{ role: "user", content: `${SUMMARY_PREFIX}\nfake` }],
      tokenBudget: 100_000,
    });
    expect(rightPrefixWrongRole.previousSummary).toBe(undefined);
    expect(rightPrefixWrongRole.kept[0]).toEqual({
      role: "user",
      content: `${SUMMARY_PREFIX}\nfake`,
    });
  });

  it("drops the oldest messages until within budget", () => {
    const messages = Array.from({ length: 5 }, () => msg(400));
    const result = splitHistoryByBudget({ messages, tokenBudget: 300 });
    expect(result.dropped).toEqual(messages.slice(0, 3));
    expect(result.kept).toEqual(messages.slice(3));
  });

  it("never empties kept even when the survivor exceeds the budget", () => {
    const messages = Array.from({ length: 5 }, () => msg(400));
    const result = splitHistoryByBudget({ messages, tokenBudget: 0 });
    expect(result.kept).toHaveLength(1);
    expect(result.kept).toEqual([messages[4]]);
    expect(result.dropped).toEqual(messages.slice(0, 4));
  });

  it("excludes the extracted summary's size from the budget", () => {
    const result = splitHistoryByBudget({
      messages: [makeSummaryMessage("x".repeat(4000)), msg(400), msg(400)],
      tokenBudget: 240,
    });
    expect(result.dropped).toEqual([]);
    expect(result.kept).toHaveLength(2);
  });
});

describe("SUMMARY_PREFIX and makeSummaryMessage", () => {
  it("pins the persisted prefix string and the summary-message shape", () => {
    expect(SUMMARY_PREFIX).toBe("[Previous conversation summary]");
    expect(makeSummaryMessage("S")).toEqual({
      role: "system",
      content: "[Previous conversation summary]\nS",
    });
  });
});

describe("system-message round-trip through write/load", () => {
  it("survives ChatStore.overwriteHistory, load, and extraction losslessly", () => {
    const store = new ChatStore(dataDir);
    const text = "alpha\nbeta";
    store.overwriteHistory("rt", [makeSummaryMessage(text), { role: "user", content: "tail" }]);
    const { messages } = store.load("rt");
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    const split = splitHistoryByBudget({ messages, tokenBudget: 100_000 });
    expect(split.previousSummary).toBe(text);
    expect(split.kept).toEqual([{ role: "user", content: "tail" }]);
  });
});
