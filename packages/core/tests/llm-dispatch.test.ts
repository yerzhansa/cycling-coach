import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import type { Config } from "../src/config.js";

const MINIMAL_RESULT = { text: "ok", toolCalls: [], finishReason: "stop", usage: {}, totalUsage: {}, steps: [] };

function codexConfig(): Config {
  return {
    llm: { provider: "openai-codex", model: "gpt-5.4", apiKey: "", authProfile: "openai-codex" },
    intervals: { apiKey: "", athleteId: "0" },
    telegram: { botToken: "" },
    session: { historyTokenBudgetRatio: 0.3, idleMinutes: 0, dailyResetHour: 4, resetArchiveRetentionDays: 0, timezone: "" },
    contextWindowTokens: 272_000,
    dataDir: "/tmp/cc-dispatch-test",
  };
}

function anthropicConfig(): Config {
  return {
    llm: { provider: "anthropic", model: "claude-test", apiKey: "test-key" },
    intervals: { apiKey: "", athleteId: "0" },
    telegram: { botToken: "" },
    session: { historyTokenBudgetRatio: 0.3, idleMinutes: 0, dailyResetHour: 4, resetArchiveRetentionDays: 0, timezone: "" },
    contextWindowTokens: 272_000,
    dataDir: "/tmp/cc-dispatch-test",
  };
}

type Captured = {
  stepLimit: number | undefined;
  cacheKey: string | undefined;
  signal: AbortSignal | undefined;
  called: number;
};

async function runCodex(opts: Parameters<import("../src/llm.js").LLM["generate"]>[0]): Promise<Captured> {
  const captured: Captured = { stepLimit: undefined, cacheKey: undefined, signal: undefined, called: 0 };
  vi.doMock("../src/agent/codex-bridge.js", () => ({
    codexGenerateText: vi.fn(async (o: { stepLimit?: number; cacheKey?: string; signal?: AbortSignal }) => {
      captured.stepLimit = o.stepLimit;
      captured.cacheKey = o.cacheKey;
      captured.signal = o.signal;
      captured.called++;
      return MINIMAL_RESULT;
    }),
  }));
  const { LLM } = await import("../src/llm.js");
  const llm = new LLM(codexConfig());
  await llm.generate(opts);
  return captured;
}

type AiSdkCaptured = {
  abortSignal: AbortSignal | undefined;
  maxRetries: number | undefined;
  prompt: string | undefined;
  messages: unknown;
  called: number;
};

async function runAiSdk(opts: Parameters<import("../src/llm.js").LLM["generate"]>[0]): Promise<AiSdkCaptured> {
  const captured: AiSdkCaptured = {
    abortSignal: undefined,
    maxRetries: undefined,
    prompt: undefined,
    messages: undefined,
    called: 0,
  };
  vi.doMock("ai", () => ({
    generateText: vi.fn(async (o: { abortSignal?: AbortSignal; maxRetries?: number; prompt?: string; messages?: unknown }) => {
      captured.abortSignal = o.abortSignal;
      captured.maxRetries = o.maxRetries;
      captured.prompt = o.prompt;
      captured.messages = o.messages;
      captured.called++;
      return MINIMAL_RESULT;
    }),
    stepCountIs: vi.fn((count: number) => ({ type: "step-count", count })),
  }));
  vi.doMock("@ai-sdk/anthropic", () => ({
    createAnthropic: () => () => ({ provider: "anthropic-stub" }),
  }));
  const { LLM } = await import("../src/llm.js");
  const llm = new LLM(anthropicConfig());
  await llm.generate(opts);
  return captured;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LLM dispatch — codex path forwards maxSteps to bridge", () => {
  it("forwards opts.maxSteps to the bridge as stepLimit", async () => {
    const captured = await runCodex({
      messages: [{ role: "user", content: "hi" }],
      maxSteps: 5,
    });
    expect(captured.called).toBe(1);
    expect(captured.stepLimit).toBe(5);
  });

  it("forwards undefined when maxSteps is not provided (bridge applies its own default)", async () => {
    const captured = await runCodex({ messages: [{ role: "user", content: "hi" }] });
    expect(captured.stepLimit).toBeUndefined();
  });

  it("forwards opts.cacheKey to the bridge", async () => {
    const captured = await runCodex({
      messages: [{ role: "user", content: "hi" }],
      cacheKey: "deadbeefdeadbeef",
    });
    expect(captured.cacheKey).toBe("deadbeefdeadbeef");
  });

  it("creates the default deadline signal and forwards it to the bridge", async () => {
    const timeoutController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);

    const captured = await runCodex({ messages: [{ role: "user", content: "hi" }] });
    const { LLM_CALL_DEADLINE_MS } = await import("../src/llm.js");

    expect(timeoutSpy).toHaveBeenCalledWith(LLM_CALL_DEADLINE_MS);
    expect(captured.signal).toBe(timeoutController.signal);
  });

  it("uses the longer chat deadline for chat calls", async () => {
    const timeoutController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);

    const captured = await runCodex({ messages: [{ role: "user", content: "hi" }], caller: "chat" });
    const { CHAT_LLM_CALL_DEADLINE_MS } = await import("../src/llm.js");

    expect(timeoutSpy).toHaveBeenCalledWith(CHAT_LLM_CALL_DEADLINE_MS);
    expect(captured.signal).toBe(timeoutController.signal);
  });
});

describe("LLM dispatch — AI SDK path forwards abort signals", () => {
  it("passes a default deadline signal and keeps SDK retries disabled on messages calls", async () => {
    const timeoutController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);

    const captured = await runAiSdk({ messages: [{ role: "user", content: "hi" }] });
    const { LLM_CALL_DEADLINE_MS } = await import("../src/llm.js");

    expect(timeoutSpy).toHaveBeenCalledWith(LLM_CALL_DEADLINE_MS);
    expect(captured.abortSignal).toBe(timeoutController.signal);
    expect(captured.maxRetries).toBe(0);
    expect(captured.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("passes the deadline signal on prompt-only calls too", async () => {
    const timeoutController = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);

    const captured = await runAiSdk({ prompt: "summarize this" });

    expect(captured.abortSignal).toBe(timeoutController.signal);
    expect(captured.prompt).toBe("summarize this");
    expect(captured.maxRetries).toBe(0);
  });
});

describe("LLM generate — per-call deadline bounded by opts.deadlineMs", () => {
  it("uses the smaller of the caller deadline and opts.deadlineMs", async () => {
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(new AbortController().signal);

    await runAiSdk({ messages: [{ role: "user", content: "hi" }], caller: "chat", deadlineMs: 120_000 });

    expect(timeoutSpy).toHaveBeenCalledWith(120_000);
  });

  it("ignores opts.deadlineMs when it exceeds the caller deadline", async () => {
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(new AbortController().signal);

    await runAiSdk({ messages: [{ role: "user", content: "hi" }], caller: "chat", deadlineMs: 999_999 });
    const { CHAT_LLM_CALL_DEADLINE_MS } = await import("../src/llm.js");

    expect(timeoutSpy).toHaveBeenCalledWith(CHAT_LLM_CALL_DEADLINE_MS);
  });
});

describe("LLM generate — timeout reclassification gated on our timer + abort shape", () => {
  function abortedTimeoutSignal(): AbortSignal {
    const ac = new AbortController();
    ac.abort(new DOMException("The operation timed out.", "TimeoutError"));
    return ac.signal;
  }

  async function generateThrowing(thrown: unknown): Promise<unknown> {
    vi.doMock("ai", () => ({
      generateText: vi.fn(async () => {
        throw thrown;
      }),
      stepCountIs: vi.fn((count: number) => ({ type: "step-count", count })),
    }));
    vi.doMock("@ai-sdk/anthropic", () => ({
      createAnthropic: () => () => ({ provider: "anthropic-stub" }),
    }));
    // The per-call timer has already fired by the time dispatch throws.
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(abortedTimeoutSignal());

    const { LLM } = await import("../src/llm.js");
    const llm = new LLM(anthropicConfig());
    let rejected = false;
    let caught: unknown;
    try {
      await llm.generate({ messages: [{ role: "user", content: "hi" }] });
    } catch (err) {
      rejected = true;
      caught = err;
    }
    expect(rejected).toBe(true);
    return caught;
  }

  it("does NOT relabel a 5xx thrown while the deadline signal is aborted", async () => {
    const serverErr = Object.assign(new Error("upstream 500"), { httpStatus: 500 });
    const caught = await generateThrowing(serverErr);
    expect(caught).toBe(serverErr);
    expect((caught as Error).name).not.toBe("TimeoutError");
    expect((caught as { httpStatus?: number }).httpStatus).toBe(500);
  });

  it("surfaces a genuine per-call abort as a TimeoutError", async () => {
    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    const caught = await generateThrowing(abortErr);
    expect((caught as Error).name).toBe("TimeoutError");
  });

  // Sibling of generateThrowing: our timer never fires (AbortSignal.timeout
  // returns a non-aborted signal), and opts.signal is threaded through so an
  // OUTER caller cancellation can be exercised.
  async function generateThrowingWithSignal(
    thrown: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    vi.doMock("ai", () => ({
      generateText: vi.fn(async () => {
        throw thrown;
      }),
      stepCountIs: vi.fn((count: number) => ({ type: "step-count", count })),
    }));
    vi.doMock("@ai-sdk/anthropic", () => ({
      createAnthropic: () => () => ({ provider: "anthropic-stub" }),
    }));
    // Our per-call timer never fires: deadline.aborted stays false.
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);

    const { LLM } = await import("../src/llm.js");
    const llm = new LLM(anthropicConfig());
    let rejected = false;
    let caught: unknown;
    try {
      await llm.generate({ messages: [{ role: "user", content: "hi" }], signal });
    } catch (err) {
      rejected = true;
      caught = err;
    }
    expect(rejected).toBe(true);
    return caught;
  }

  it("does NOT relabel an outer-signal abort when our timer never fired", async () => {
    const outer = new AbortController();
    outer.abort(new DOMException("The operation was aborted.", "AbortError"));
    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    const caught = await generateThrowingWithSignal(abortErr, outer.signal);
    expect((caught as Error).name).toBe("AbortError");
    expect((caught as Error).name).not.toBe("TimeoutError");
  });

  it("relabels a genuine deadline abort wrapped under a non-standard name", async () => {
    const wrapped = Object.assign(new Error("api call failed"), {
      name: "AI_APICallError",
      cause: Object.assign(new Error("aborted"), { name: "AbortError" }),
    });
    const caught = await generateThrowing(wrapped);
    expect((caught as Error).name).toBe("TimeoutError");
  });
});
