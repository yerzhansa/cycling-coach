import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../src/config.js";
import type { UsageLedgerLine } from "../src/usage-ledger.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cc-ledger-"));
  vi.resetModules();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function ledgerLine(overrides: Partial<UsageLedgerLine> = {}): UsageLedgerLine {
  return {
    ts: 1,
    kind: "generate",
    caller: undefined,
    provider: "anthropic",
    model: "claude-test",
    durationMs: 12,
    steps: 1,
    inputTokens: 5,
    outputTokens: 3,
    totalTokens: 8,
    cacheReadTokens: undefined,
    cacheWriteTokens: undefined,
    cost: undefined,
    stopReason: "stop",
    ...overrides,
  };
}

function anthropicConfig(dataDir: string): Config {
  return {
    llm: { provider: "anthropic", model: "claude-test", apiKey: "sk-test" },
    intervals: { apiKey: "", athleteId: "0" },
    telegram: { botToken: "" },
    session: { historyTokenBudgetRatio: 0.3, idleMinutes: 0, dailyResetHour: 4, resetArchiveRetentionDays: 0, timezone: "" },
    contextWindowTokens: 272_000,
    dataDir,
  };
}

function codexConfig(dataDir: string): Config {
  return {
    llm: { provider: "openai-codex", model: "gpt-5.4", apiKey: "", authProfile: "openai-codex" },
    intervals: { apiKey: "", athleteId: "0" },
    telegram: { botToken: "" },
    session: { historyTokenBudgetRatio: 0.3, idleMinutes: 0, dailyResetHour: 4, resetArchiveRetentionDays: 0, timezone: "" },
    contextWindowTokens: 272_000,
    dataDir,
  };
}

function readLines(dataDir: string, file = "usage-ledger.jsonl"): string[] {
  return readFileSync(join(dataDir, file), "utf-8").split("\n").filter((l) => l.length > 0);
}

describe("appendUsageLine", () => {
  it("writes one JSON line per call to <dataDir>/usage-ledger.jsonl", async () => {
    const { appendUsageLine } = await import("../src/usage-ledger.js");
    appendUsageLine(dir, ledgerLine({ kind: "generate" }));
    appendUsageLine(dir, ledgerLine({ kind: "turn" }));

    const lines = readLines(dir);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const parsed = JSON.parse(line) as UsageLedgerLine;
      expect(parsed.kind).toBeDefined();
      expect(parsed.durationMs).toBeDefined();
      expect(parsed.provider).toBe("anthropic");
    }
  });

  it("rotates the ledger to .jsonl.1 once it crosses 10 MB", async () => {
    const { appendUsageLine } = await import("../src/usage-ledger.js");
    const path = join(dir, "usage-ledger.jsonl");
    writeFileSync(path, "x".repeat(10.5 * 1024 * 1024));

    appendUsageLine(dir, ledgerLine());

    expect(existsSync(join(dir, "usage-ledger.jsonl.1"))).toBe(true);
    expect(readLines(dir)).toHaveLength(1);
    expect(statSync(path).size).toBeLessThan(1024);
  });

  it("never throws when the ledger write fails", async () => {
    const { appendUsageLine } = await import("../src/usage-ledger.js");
    const badDir = "/nonexistent/dir/that/cannot/be/created/\0bad";
    expect(() => appendUsageLine(badDir, ledgerLine())).not.toThrow();
  });
});

describe("LLM.generate — AI-SDK path", () => {
  async function loadLLMWithGenerateText(stub: Record<string, unknown>) {
    const generateText = vi.fn(async () => stub);
    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return { ...actual, generateText };
    });
    const { LLM } = await import("../src/llm.js");
    return { LLM, generateText };
  }

  it("returns whole-turn totalUsage and the step count from the SDK result", async () => {
    const { LLM } = await loadLLMWithGenerateText({
      text: "ok",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      totalUsage: { inputTokens: 30, outputTokens: 20, totalTokens: 50 },
      steps: [{ s: "a" }, { s: "b" }, { s: "c" }],
    });
    const llm = new LLM(anthropicConfig(dir));

    const result = await llm.generate({ prompt: "hi" });

    expect(result.totalUsage?.inputTokens).toBe(30);
    expect(result.steps).toBe(3);
    expect(result.usage.inputTokens).toBe(3);
  });

  it("writes a caller-tagged generate ledger line reading from totalUsage", async () => {
    const { LLM } = await loadLLMWithGenerateText({
      text: "ok",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      totalUsage: {
        inputTokens: 30,
        outputTokens: 20,
        totalTokens: 50,
        inputTokenDetails: { cacheReadTokens: 7, cacheWriteTokens: 4 },
      },
      steps: [{ s: "a" }, { s: "b" }],
    });
    const llm = new LLM(anthropicConfig(dir));

    await llm.generate({ prompt: "hi", caller: "flush" });

    const lines = readLines(dir);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as UsageLedgerLine;
    expect(parsed.kind).toBe("generate");
    expect(parsed.caller).toBe("flush");
    expect(parsed.totalTokens).toBe(50);
    expect(parsed.cacheReadTokens).toBe(7);
    expect(parsed.cacheWriteTokens).toBe(4);
    expect(parsed.steps).toBe(2);
  });
});

describe("codex bridge — usage accumulation across the loop", () => {
  function piUsage(input: number, output: number, cost = 0) {
    return {
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
    };
  }

  function asstMsg(overrides: Record<string, unknown> = {}) {
    return {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "hi" }],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-5.4",
      usage: piUsage(10, 5),
      stopReason: "stop" as const,
      timestamp: 1,
      ...overrides,
    };
  }

  async function loadBridge(complete: ReturnType<typeof vi.fn>) {
    vi.doMock("@mariozechner/pi-ai", () => ({
      complete,
      getModel: vi.fn(() => ({
        id: "gpt-5.4",
        name: "gpt-5.4",
        api: "openai-codex-responses",
        provider: "openai-codex",
        baseUrl: "https://chatgpt.com/backend-api",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 272_000,
        maxTokens: 128_000,
      })),
    }));
    vi.doMock("../src/auth/profiles.js", () => ({
      getFreshToken: vi.fn(async () => "test-access-token"),
    }));
    const { codexGenerateText } = await import("../src/agent/codex-bridge.js");
    return codexGenerateText;
  }

  it("sums usage across a multi-step loop and keeps last-step usage for back-compat", async () => {
    const calls = [
      asstMsg({
        stopReason: "toolUse",
        usage: piUsage(10, 5),
        content: [{ type: "toolCall", id: "c1", name: "noop", arguments: {} }],
      }),
      asstMsg({ stopReason: "stop", usage: piUsage(20, 7) }),
    ];
    let i = 0;
    const complete = vi.fn(async () => calls[i++]);
    const codexGenerateText = await loadBridge(complete);

    const result = await codexGenerateText({
      messages: [{ role: "user", content: "hi" }],
      tools: { noop: {} } as never,
      modelId: "gpt-5.4",
      profileName: "openai-codex",
    });

    expect(result.totalUsage?.inputTokens).toBe(30);
    expect(result.steps).toBe(2);
    expect(result.usage.inputTokens).toBe(20);
  });

  it("carries pi-ai's per-call cost object on the result", async () => {
    const complete = vi.fn(async () => asstMsg({ usage: piUsage(10, 5, 0.03) }));
    const codexGenerateText = await loadBridge(complete);

    const result = await codexGenerateText({
      messages: [{ role: "user", content: "hi" }],
      modelId: "gpt-5.4",
      profileName: "openai-codex",
    });

    expect(result.cost?.total).toBe(0.03);
  });
});

describe("LLM.generate — codex path writes a ledger line", () => {
  it("appends a generate line via the chokepoint after the bridge returns", async () => {
    vi.doMock("../src/agent/codex-bridge.js", () => ({
      codexGenerateText: vi.fn(async () => ({
        text: "ok",
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 20, outputTokens: 7, totalTokens: 27 },
        totalUsage: { inputTokens: 30, outputTokens: 12, totalTokens: 42 },
        steps: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.03 },
      })),
    }));
    const { LLM } = await import("../src/llm.js");
    const llm = new LLM(codexConfig(dir));

    await llm.generate({ prompt: "hi", caller: "chat" });

    const lines = readLines(dir);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as UsageLedgerLine;
    expect(parsed.kind).toBe("generate");
    expect(parsed.caller).toBe("chat");
    expect(parsed.provider).toBe("openai-codex");
    expect(parsed.totalTokens).toBe(42);
    expect(parsed.cost?.total).toBe(0.03);
  });
});
