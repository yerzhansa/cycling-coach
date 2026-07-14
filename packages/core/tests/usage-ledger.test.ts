import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, statSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cyclingSport } from "@enduragent/sport-cycling";
import type { Config } from "../src/config.js";
import type { Sport } from "../src/sport.js";
import type { UsageLedgerLine } from "../src/usage-ledger.js";
import { baseAgentConfig } from "./helpers/base-agent-config.js";

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
    templateHash: undefined,
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

describe("usageFieldsFromResult", () => {
  it("maps whole-turn usage, cache details, and cost onto the ledger fields", async () => {
    const { usageFieldsFromResult } = await import("../src/usage-ledger.js");
    const fields = usageFieldsFromResult({
      text: "ok",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      totalUsage: {
        inputTokens: 30,
        outputTokens: 12,
        totalTokens: 42,
        inputTokenDetails: { cacheReadTokens: 7, cacheWriteTokens: 4 },
      },
      steps: 1,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.03 },
    } as unknown as import("../src/llm-types.js").GenerateResult);

    expect(fields).toEqual({
      inputTokens: 30,
      outputTokens: 12,
      totalTokens: 42,
      cacheReadTokens: 7,
      cacheWriteTokens: 4,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.03 },
    });
  });

  it("leaves token fields undefined when totalUsage is absent", async () => {
    const { usageFieldsFromResult } = await import("../src/usage-ledger.js");
    const fields = usageFieldsFromResult({
      text: "ok",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      totalUsage: undefined,
      cost: undefined,
    } as unknown as import("../src/llm-types.js").GenerateResult);

    expect(fields.inputTokens).toBeUndefined();
    expect(fields.totalTokens).toBeUndefined();
    expect(fields.cacheReadTokens).toBeUndefined();
    expect(fields.cacheWriteTokens).toBeUndefined();
    expect(fields.cost).toBeUndefined();
  });
});

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

  it("carries the per-turn token usage and cost on a turn line", async () => {
    const { appendUsageLine } = await import("../src/usage-ledger.js");
    appendUsageLine(
      dir,
      ledgerLine({
        kind: "turn",
        templateHash: "0123456789abcdef",
        inputTokens: 30,
        outputTokens: 12,
        totalTokens: 42,
        cacheReadTokens: 7,
        cacheWriteTokens: 4,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.03 },
      }),
    );

    const parsed = JSON.parse(readLines(dir)[0]) as UsageLedgerLine;
    expect(parsed.kind).toBe("turn");
    expect(parsed.inputTokens).toBe(30);
    expect(parsed.outputTokens).toBe(12);
    expect(parsed.totalTokens).toBe(42);
    expect(parsed.cacheReadTokens).toBe(7);
    expect(parsed.cacheWriteTokens).toBe(4);
    expect(parsed.cost?.total).toBe(0.03);
    expect(parsed.templateHash).toBe("0123456789abcdef");
  });

  it("omits templateHash on a generate line and round-trips it on a turn line", async () => {
    const { appendUsageLine } = await import("../src/usage-ledger.js");
    appendUsageLine(dir, ledgerLine({ kind: "generate" }));
    appendUsageLine(dir, ledgerLine({ kind: "turn", templateHash: "abcdef0123456789" }));

    const [gen, turn] = readLines(dir).map((l) => JSON.parse(l) as UsageLedgerLine);
    expect(gen.kind).toBe("generate");
    expect(gen.templateHash).toBeUndefined();
    expect(turn.kind).toBe("turn");
    expect(turn.templateHash).toBe("abcdef0123456789");
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

  it("prices the generate line from the price table when the model is catalogued", async () => {
    const { PRICE_TABLE } = await import("../src/agent/codex/cost.js");
    const known = Object.entries(PRICE_TABLE.anthropic).find(([, c]) => c.input > 0);
    if (!known) throw new Error("expected at least one priced anthropic model in the catalog");
    const [knownId, knownCost] = known;

    const { LLM } = await loadLLMWithGenerateText({
      text: "ok",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      totalUsage: { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 },
      steps: [{ s: "a" }],
    });
    const config: Config = { ...anthropicConfig(dir), llm: { provider: "anthropic", model: knownId, apiKey: "sk-test" } };
    const llm = new LLM(config);

    await llm.generate({ prompt: "hi", caller: "chat" });

    const parsed = JSON.parse(readLines(dir)[0]) as UsageLedgerLine;
    expect(parsed.cost).toBeDefined();
    // 1,000,000 input tokens at a per-million-token rate equals exactly that rate.
    expect(parsed.cost?.input).toBeCloseTo(knownCost.input, 10);
    expect(parsed.cost?.total).toBeCloseTo(knownCost.input, 10);
  });

  it("leaves cost undefined when the model is not in the catalog", async () => {
    const { LLM } = await loadLLMWithGenerateText({
      text: "ok",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      totalUsage: { inputTokens: 30, outputTokens: 20, totalTokens: 50 },
      steps: [{ s: "a" }],
    });
    const llm = new LLM(anthropicConfig(dir)); // model "claude-test" — not catalogued

    await llm.generate({ prompt: "hi", caller: "chat" });

    const parsed = JSON.parse(readLines(dir)[0]) as UsageLedgerLine;
    expect(parsed.cost).toBeUndefined();
  });
});

describe("codex bridge — usage accumulation across the loop", () => {
  function tokens(input: number, output: number) {
    return { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output };
  }

  function asstMsg(
    overrides: {
      text?: string;
      toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
      usage?: ReturnType<typeof tokens>;
      stopReason?: "stop" | "length" | "toolUse" | "error";
    } = {},
  ) {
    return {
      text: overrides.text ?? "hi",
      toolCalls: overrides.toolCalls ?? [],
      usage: overrides.usage ?? tokens(10, 5),
      stopReason: overrides.stopReason ?? "stop",
    };
  }

  async function loadBridge(complete: ReturnType<typeof vi.fn>) {
    vi.doMock("../src/agent/codex/responses.js", () => ({
      codexResponses: complete,
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
        usage: tokens(10, 5),
        toolCalls: [{ id: "c1", name: "noop", arguments: {} }],
      }),
      asstMsg({ stopReason: "stop", usage: tokens(20, 7) }),
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

  it("computes the result cost from the codex price table (gpt-5.4 rates)", async () => {
    const complete = vi.fn(async () => asstMsg({ usage: tokens(10, 5) }));
    const codexGenerateText = await loadBridge(complete);

    const result = await codexGenerateText({
      messages: [{ role: "user", content: "hi" }],
      modelId: "gpt-5.4",
      profileName: "openai-codex",
    });

    // gpt-5.4: input 2.5, output 15 per 1e6 tokens → (2.5*10 + 15*5)/1e6 = 0.0001.
    expect(result.cost?.total).toBeCloseTo(0.0001, 12);
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

describe("turn line — winning generation usage and cost", () => {
  let tempHome: string;
  let origHome: string | undefined;
  let agentDataDir: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "cc-turn-"));
    origHome = process.env.HOME;
    process.env.HOME = tempHome;
    agentDataDir = join(tempHome, ".cycling-coach");
    mkdirSync(agentDataDir, { recursive: true });
    mkdirSync(join(agentDataDir, "memory"), { recursive: true });
    vi.resetModules();
    // A sibling describe block stubs the codex bridge to a fixed reply; drop
    // that registration so this block drives the real retry loop.
    vi.doUnmock("../src/agent/codex-bridge.js");
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(tempHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function tokens(input: number, output: number) {
    return { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output };
  }

  function mkAssistant(text: string, usage = tokens(0, 0)) {
    return {
      text,
      toolCalls: [] as Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
      usage,
      stopReason: "stop" as const,
    };
  }

  async function setupAgent(complete: ReturnType<typeof vi.fn>) {
    vi.doMock("../src/agent/codex/responses.js", () => ({
      codexResponses: complete,
    }));
    vi.doMock("../src/agent/codex/oauth.js", () => ({
      refreshCodexToken: vi.fn(),
      loginCodex: vi.fn(),
    }));
    vi.doMock("../src/auth/profiles.js", () => ({
      getFreshToken: vi.fn(async () => "token"),
      loadProfile: vi.fn(),
      saveProfile: vi.fn(),
      RefreshTokenReusedError: class extends Error {},
    }));
    const { CoachAgent } = await import("../src/agent/coach-agent.js");
    return new CoachAgent(cyclingSport as unknown as Sport, baseAgentConfig(agentDataDir));
  }

  it("records the final successful generation's usage/cost, not a failed attempt's", async () => {
    let n = 0;
    const complete = vi.fn(async () => {
      n++;
      if (n === 1) {
        // First attempt overflows: its usage must never reach the turn line.
        throw new Error("Request exceeds the maximum context length of 272000 tokens");
      }
      // The winning retry carries the figures the turn line must report.
      return mkAssistant("recovered", tokens(30, 12));
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = await setupAgent(complete);

    const text = await agent.chat("turn-winner", "hello");
    expect(text).toBe("recovered");

    const turnLine = readLines(agentDataDir)
      .map((l) => JSON.parse(l) as UsageLedgerLine)
      .find((l) => l.kind === "turn");
    expect(turnLine).toBeDefined();
    expect(turnLine?.inputTokens).toBe(30);
    expect(turnLine?.outputTokens).toBe(12);
    expect(turnLine?.totalTokens).toBe(42);
    // Computed from the codex price table: (2.5*30 + 15*12)/1e6 = 0.000255.
    expect(turnLine?.cost?.total).toBeCloseTo(0.000255, 12);
    expect(turnLine?.templateHash).toMatch(/^[0-9a-f]{16}$/);
  });
});
