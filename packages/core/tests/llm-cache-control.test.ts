import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import type { Config } from "../src/config.js";

function anthropicConfig(): Config {
  return {
    llm: { provider: "anthropic", model: "claude-sonnet-4-6", apiKey: "test-key" },
    intervals: { apiKey: "", athleteId: "0" },
    telegram: { botToken: "" },
    session: { historyTokenBudgetRatio: 0.3, idleMinutes: 0, dailyResetHour: 4, resetArchiveRetentionDays: 0, timezone: "" },
    contextWindowTokens: 272_000,
    dataDir: "/tmp/cc-cache-control-test",
  };
}

function codexConfig(): Config {
  return {
    llm: { provider: "openai-codex", model: "gpt-5.4", apiKey: "", authProfile: "openai-codex" },
    intervals: { apiKey: "", athleteId: "0" },
    telegram: { botToken: "" },
    session: { historyTokenBudgetRatio: 0.3, idleMinutes: 0, dailyResetHour: 4, resetArchiveRetentionDays: 0, timezone: "" },
    contextWindowTokens: 272_000,
    dataDir: "/tmp/cc-cache-control-test",
  };
}

const MINIMAL_RESULT = { text: "ok", toolCalls: [], finishReason: "stop", usage: {} };

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LLM cache control — Anthropic system breakpoint", () => {
  it("passes the system as a cache-controlled block array on the anthropic path", async () => {
    let captured: { system?: unknown } | undefined;
    vi.doMock("ai", () => ({
      generateText: vi.fn(async (arg: { system?: unknown }) => {
        captured = arg;
        return MINIMAL_RESULT;
      }),
    }));
    vi.doMock("@ai-sdk/anthropic", () => ({
      createAnthropic: () => () => ({ provider: "anthropic-stub" }),
    }));

    const { LLM } = await import("../src/llm.js");
    const llm = new LLM(anthropicConfig());
    await llm.generate({
      system: "STABLE SYSTEM PROMPT",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(Array.isArray(captured?.system)).toBe(true);
    const blocks = captured?.system as Array<{
      role: string;
      content: string;
      providerOptions?: { anthropic?: { cacheControl?: { type?: string } } };
    }>;
    const last = blocks[blocks.length - 1];
    expect(last.role).toBe("system");
    expect(last.content).toBe("STABLE SYSTEM PROMPT");
    expect(last.providerOptions?.anthropic?.cacheControl?.type).toBe("ephemeral");
  });

  it("forwards a plain-string system with no cacheControl on the codex path", async () => {
    let captured: { system?: unknown } | undefined;
    vi.doMock("../src/agent/codex-bridge.js", () => ({
      codexGenerateText: vi.fn(async (arg: { system?: unknown }) => {
        captured = arg;
        return MINIMAL_RESULT;
      }),
    }));

    const { LLM } = await import("../src/llm.js");
    const llm = new LLM(codexConfig());
    await llm.generate({
      system: "STABLE SYSTEM PROMPT",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(typeof captured?.system).toBe("string");
    expect(captured?.system).toBe("STABLE SYSTEM PROMPT");
  });
});
