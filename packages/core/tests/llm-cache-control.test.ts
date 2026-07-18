import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import type { ModelMessage } from "ai";
import type { Config } from "../src/config.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../src/agent/system-prompt.js";

function anthropicConfig(): Config {
  return {
    dataSource: "platform",
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
    dataSource: "platform",
    llm: { provider: "openai-codex", model: "gpt-5.4", apiKey: "", authProfile: "openai-codex" },
    intervals: { apiKey: "", athleteId: "0" },
    telegram: { botToken: "" },
    session: { historyTokenBudgetRatio: 0.3, idleMinutes: 0, dailyResetHour: 4, resetArchiveRetentionDays: 0, timezone: "" },
    contextWindowTokens: 272_000,
    dataDir: "/tmp/cc-cache-control-test",
  };
}

function aiSdkConfig(provider: "openai" | "google", model: string): Config {
  return {
    dataSource: "platform",
    llm: { provider, model, apiKey: "test-key" },
    intervals: { apiKey: "", athleteId: "0" },
    telegram: { botToken: "" },
    session: { historyTokenBudgetRatio: 0.3, idleMinutes: 0, dailyResetHour: 4, resetArchiveRetentionDays: 0, timezone: "" },
    contextWindowTokens: 272_000,
    dataDir: "/tmp/cc-cache-control-test",
  };
}

function openrouterConfig(model: string): Config {
  return {
    dataSource: "platform",
    llm: { provider: "openrouter", model, apiKey: "test-key" },
    intervals: { apiKey: "", athleteId: "0" },
    telegram: { botToken: "" },
    session: { historyTokenBudgetRatio: 0.3, idleMinutes: 0, dailyResetHour: 4, resetArchiveRetentionDays: 0, timezone: "" },
    contextWindowTokens: 272_000,
    dataDir: "/tmp/cc-cache-control-test",
  };
}

const MINIMAL_RESULT = { text: "ok", toolCalls: [], finishReason: "stop", usage: {}, totalUsage: {}, steps: [] };

const MARKED = "STABLE PREFIX" + SYSTEM_PROMPT_CACHE_BOUNDARY + "\n\nVOLATILE TAIL";

type CapturedBlock = {
  role: string;
  content: string;
  providerOptions?: Record<string, { cacheControl?: { type?: string } }>;
};
type CapturedArg = {
  system?: unknown;
  messages?: Array<{ role: string; content: unknown; providerOptions?: Record<string, unknown> }>;
};

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LLM cache control — Anthropic system breakpoint", () => {
  it("splits a marker-bearing system into two cache-controlled blocks", async () => {
    let captured: CapturedArg | undefined;
    vi.doMock("ai", () => ({
      generateText: vi.fn(async (arg: CapturedArg) => {
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
      system: MARKED,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(Array.isArray(captured?.system)).toBe(true);
    const blocks = captured?.system as CapturedBlock[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0].content).toBe("STABLE PREFIX");
    expect(blocks[1].content.startsWith("<!-- cache boundary:")).toBe(true);
    expect(blocks[1].content.endsWith("VOLATILE TAIL")).toBe(true);
    expect(blocks[0].providerOptions?.anthropic?.cacheControl?.type).toBe("ephemeral");
    expect(blocks[1].providerOptions?.anthropic?.cacheControl?.type).toBe("ephemeral");
  });

  it("passes a marker-less system as a single cache-controlled block", async () => {
    let captured: CapturedArg | undefined;
    vi.doMock("ai", () => ({
      generateText: vi.fn(async (arg: CapturedArg) => {
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
    const blocks = captured?.system as CapturedBlock[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe("STABLE SYSTEM PROMPT");
    expect(blocks[0].providerOptions?.anthropic?.cacheControl?.type).toBe("ephemeral");
  });

  it("stamps the last message without mutating the caller's array", async () => {
    let captured: CapturedArg | undefined;
    vi.doMock("ai", () => ({
      generateText: vi.fn(async (arg: CapturedArg) => {
        captured = arg;
        return MINIMAL_RESULT;
      }),
    }));
    vi.doMock("@ai-sdk/anthropic", () => ({
      createAnthropic: () => () => ({ provider: "anthropic-stub" }),
    }));

    const { LLM } = await import("../src/llm.js");
    const llm = new LLM(anthropicConfig());
    const callerMessages: ModelMessage[] = [
      { role: "user", content: "a" },
      { role: "user", content: "b" },
    ];
    await llm.generate({ system: "STABLE SYSTEM PROMPT", messages: callerMessages });

    expect(captured?.messages?.[1].providerOptions?.anthropic).toEqual({ cacheControl: { type: "ephemeral" } });
    expect(captured?.messages?.[0].providerOptions).toBeUndefined();
    // The caller's array must be left untouched — it feeds the retry loop and
    // the assembled-hash basis.
    expect((callerMessages[0] as { providerOptions?: unknown }).providerOptions).toBeUndefined();
    expect((callerMessages[1] as { providerOptions?: unknown }).providerOptions).toBeUndefined();
  });
});

describe("LLM cache control — OpenRouter routes", () => {
  it("splits and stamps on the qwen/ route under providerOptions.openrouter", async () => {
    let captured: CapturedArg | undefined;
    vi.doMock("ai", () => ({
      generateText: vi.fn(async (arg: CapturedArg) => {
        captured = arg;
        return MINIMAL_RESULT;
      }),
    }));
    vi.doMock("@openrouter/ai-sdk-provider", () => ({
      createOpenRouter: () => ({ chat: () => ({ provider: "openrouter-stub" }) }),
    }));

    const { LLM } = await import("../src/llm.js");
    const llm = new LLM(openrouterConfig("qwen/qwen3.5-plus"));
    await llm.generate({
      system: MARKED,
      messages: [{ role: "user", content: "a" }, { role: "user", content: "b" }],
    });

    const blocks = captured?.system as CapturedBlock[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0].providerOptions?.openrouter?.cacheControl?.type).toBe("ephemeral");
    expect(blocks[1].providerOptions?.openrouter?.cacheControl?.type).toBe("ephemeral");
    expect(captured?.messages?.[1].providerOptions?.openrouter).toEqual({ cacheControl: { type: "ephemeral" } });
  });

  it("leaves a non-qwen/ route uncached (plain string, no providerOptions)", async () => {
    let captured: CapturedArg | undefined;
    vi.doMock("ai", () => ({
      generateText: vi.fn(async (arg: CapturedArg) => {
        captured = arg;
        return MINIMAL_RESULT;
      }),
    }));
    vi.doMock("@openrouter/ai-sdk-provider", () => ({
      createOpenRouter: () => ({ chat: () => ({ provider: "openrouter-stub" }) }),
    }));

    const { LLM } = await import("../src/llm.js");
    const llm = new LLM(openrouterConfig("deepseek/deepseek-v4-flash"));
    await llm.generate({
      system: MARKED,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(typeof captured?.system).toBe("string");
    expect(captured?.system).toBe(MARKED);
    expect(JSON.stringify(captured)).not.toContain("cacheControl");
    expect(JSON.stringify(captured)).not.toContain("providerOptions");
  });
});

describe("LLM cache control — codex path", () => {
  it("forwards a plain-string system with no cacheControl on the codex path", async () => {
    let captured: CapturedArg | undefined;
    vi.doMock("../src/agent/codex-bridge.js", () => ({
      codexGenerateText: vi.fn(async (arg: CapturedArg) => {
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

describe("LLM cache control — non-Anthropic AI-SDK providers carry no Anthropic directive", () => {
  for (const { provider, model, mockPath, mockFactory } of [
    { provider: "openai" as const, model: "gpt-4o", mockPath: "@ai-sdk/openai", mockFactory: () => ({ createOpenAI: () => () => ({ provider: "openai-stub" }) }) },
    { provider: "google" as const, model: "gemini-2.0-flash", mockPath: "@ai-sdk/google", mockFactory: () => ({ createGoogleGenerativeAI: () => () => ({ provider: "google-stub" }) }) },
  ]) {
    it(`passes the system as a plain string with no providerOptions on the ${provider} path`, async () => {
      let captured: CapturedArg | undefined;
      vi.doMock("ai", () => ({
        generateText: vi.fn(async (arg: CapturedArg) => {
          captured = arg;
          return MINIMAL_RESULT;
        }),
      }));
      vi.doMock(mockPath, mockFactory);

      const { LLM } = await import("../src/llm.js");
      const llm = new LLM(aiSdkConfig(provider, model));
      await llm.generate({
        system: MARKED,
        messages: [{ role: "user", content: "hi" }],
      });

      expect(typeof captured?.system).toBe("string");
      expect(captured?.system).toBe(MARKED);
      expect(JSON.stringify(captured)).not.toContain("cacheControl");
      expect(JSON.stringify(captured)).not.toContain("providerOptions");
    });
  }
});
