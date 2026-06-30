import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zodSchema } from "ai";
import { z } from "zod";
import { normalizeError } from "../src/agent/codex-bridge.js";
import { isRateLimitError, isServerError, isNetworkError } from "../src/agent/token-utils.js";

// Test the bridge's error normalization, result mapping, and tool loop. Mocks the
// in-house codex round-trip (codexResponses) and auth profile access.

let tempHome: string;
let origHome: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "cc-bridge-"));
  origHome = process.env.HOME;
  process.env.HOME = tempHome;
  mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });
  vi.resetModules();
});

afterEach(() => {
  process.env.HOME = origHome;
  rmSync(tempHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function loadBridgeWithMocks(opts: {
  complete: ReturnType<typeof vi.fn>;
  freshToken?: ReturnType<typeof vi.fn>;
}) {
  vi.doMock("../src/agent/codex/responses.js", () => ({
    codexResponses: opts.complete,
  }));

  vi.doMock("../src/auth/profiles.js", () => ({
    getFreshToken: opts.freshToken ?? vi.fn(async () => "test-access-token"),
  }));

  const { codexGenerateText } = await import("../src/agent/codex-bridge.js");
  return { codexGenerateText };
}

function asstMsg(overrides: {
  text?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number };
  stopReason?: "stop" | "length" | "toolUse" | "error";
} = {}) {
  return {
    text: overrides.text ?? "hello",
    toolCalls: overrides.toolCalls ?? [],
    usage:
      overrides.usage ?? { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
    stopReason: overrides.stopReason ?? "stop",
  };
}

describe("codex-bridge", () => {
  it("returns {text, finishReason, usage} for a simple completion", async () => {
    const complete = vi.fn(async () => asstMsg());
    const { codexGenerateText } = await loadBridgeWithMocks({ complete });

    const result = await codexGenerateText({
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      modelId: "gpt-5.4",
      profileName: "openai-codex",
    });

    expect(result.text).toBe("hello");
    expect(result.finishReason).toBe("stop");
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(5);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("maps codex rate-limit errors so isRateLimitError() recognizes them", async () => {
    const complete = vi.fn(async () => {
      throw new Error("You have hit your ChatGPT usage limit (plus plan). Try again in ~5 min.");
    });
    const { codexGenerateText } = await loadBridgeWithMocks({ complete });

    const { isRateLimitError } = await import("../src/agent/token-utils.js");

    try {
      await codexGenerateText({
        messages: [{ role: "user", content: "hi" }],
        modelId: "gpt-5.4",
        profileName: "openai-codex",
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(isRateLimitError(err)).toBe(true);
    }
  });

  it("maps 'Request was aborted' to a timeout-shaped error", async () => {
    const complete = vi.fn(async () => {
      throw new Error("Request was aborted");
    });
    const { codexGenerateText } = await loadBridgeWithMocks({ complete });

    const { isTimeoutError } = await import("../src/agent/token-utils.js");

    try {
      await codexGenerateText({
        messages: [{ role: "user", content: "hi" }],
        modelId: "gpt-5.4",
        profileName: "openai-codex",
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(isTimeoutError(err)).toBe(true);
    }
  });

  it("maps context-length errors so isContextOverflowError() recognizes them", async () => {
    const complete = vi.fn(async () => {
      throw new Error("Request exceeds the maximum context length of 272000 tokens");
    });
    const { codexGenerateText } = await loadBridgeWithMocks({ complete });

    const { isContextOverflowError } = await import("../src/agent/token-utils.js");

    try {
      await codexGenerateText({
        messages: [{ role: "user", content: "hi" }],
        modelId: "gpt-5.4",
        profileName: "openai-codex",
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(isContextOverflowError(err)).toBe(true);
    }
  });

  it("calls getFreshToken before each request and forwards the token as accessToken", async () => {
    const complete = vi.fn(async () => asstMsg());
    const freshToken = vi.fn(async () => "fresh-token-abc");
    const { codexGenerateText } = await loadBridgeWithMocks({ complete, freshToken });

    await codexGenerateText({
      messages: [{ role: "user", content: "hi" }],
      modelId: "gpt-5.4",
      profileName: "openai-codex",
    });

    expect(freshToken).toHaveBeenCalledWith("openai-codex", undefined);
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "fresh-token-abc", modelId: "gpt-5.4" }),
    );
  });

  it("threads the per-call abort signal into getFreshToken so the token refresh shares the deadline", async () => {
    const complete = vi.fn(async () => asstMsg());
    const freshToken = vi.fn(async () => "fresh-token-abc");
    const { codexGenerateText } = await loadBridgeWithMocks({ complete, freshToken });
    const controller = new AbortController();

    await codexGenerateText({
      messages: [{ role: "user", content: "hi" }],
      modelId: "gpt-5.4",
      profileName: "openai-codex",
      signal: controller.signal,
    });

    expect(freshToken).toHaveBeenCalledWith("openai-codex", controller.signal);
  });

  it("forwards opts.cacheKey as the request sessionId; omits it when absent", async () => {
    const completeWithKey = vi.fn(async () => asstMsg());
    const { codexGenerateText: genWithKey } = await loadBridgeWithMocks({ complete: completeWithKey });

    await genWithKey({
      messages: [{ role: "user", content: "hi" }],
      modelId: "gpt-5.4",
      profileName: "openai-codex",
      cacheKey: "abc123def456",
    });

    expect(completeWithKey).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "abc123def456" }),
    );

    vi.resetModules();
    const completeNoKey = vi.fn(async () => asstMsg());
    const { codexGenerateText: genNoKey } = await loadBridgeWithMocks({ complete: completeNoKey });

    await genNoKey({
      messages: [{ role: "user", content: "hi" }],
      modelId: "gpt-5.4",
      profileName: "openai-codex",
    });

    expect(completeNoKey).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: undefined }),
    );
  });

  it("forwards opts.signal to the codex response request", async () => {
    const complete = vi.fn(async () => asstMsg());
    const { codexGenerateText } = await loadBridgeWithMocks({ complete });
    const signal = new AbortController().signal;

    await codexGenerateText({
      messages: [{ role: "user", content: "hi" }],
      modelId: "gpt-5.4",
      profileName: "openai-codex",
      signal,
    });

    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ signal }),
    );
  });

  it("surfaces finishReason=length so isContextOverflowError can catch it upstream via retry", async () => {
    const complete = vi.fn(async () => asstMsg({ stopReason: "length", text: "truncated" }));
    const { codexGenerateText } = await loadBridgeWithMocks({ complete });
    const res = await codexGenerateText({
      messages: [{ role: "user", content: "hi" }],
      modelId: "gpt-5.4",
      profileName: "openai-codex",
    });
    expect(res.finishReason).toBe("length");
  });

  it("stops the tool-calling loop at stepLimit", async () => {
    // Always return a toolCall — the bridge would loop forever if stepLimit
    // weren't honored. Empty tools set → executeToolCall returns an error result
    // but the loop still cycles until stepLimit.
    const complete = vi.fn(async () =>
      asstMsg({
        stopReason: "toolUse",
        toolCalls: [{ id: "c1", name: "noop", arguments: {} }],
      }),
    );
    const { codexGenerateText } = await loadBridgeWithMocks({ complete });

    await codexGenerateText({
      messages: [{ role: "user", content: "hi" }],
      tools: {} as never,
      modelId: "gpt-5.4",
      profileName: "openai-codex",
      stepLimit: 3,
    });

    expect(complete).toHaveBeenCalledTimes(3);
  });

  it("rejects schema-violating tool arguments without executing the tool", async () => {
    const execute = vi.fn(async () => "should not run");
    const tools = {
      log_ride: {
        description: "log a ride",
        inputSchema: zodSchema(z.object({ minutes: z.number() })),
        execute,
      },
    };

    const conversations: Array<{ messages: Array<Record<string, unknown>> }> = [];
    const complete = vi.fn(async (params: { messages: Array<Record<string, unknown>> }) => {
      conversations.push({ messages: [...params.messages] });
      if (conversations.length === 1) {
        return asstMsg({
          stopReason: "toolUse",
          toolCalls: [{ id: "c1", name: "log_ride", arguments: { minutes: "sixty" } }],
        });
      }
      return asstMsg();
    });
    const { codexGenerateText } = await loadBridgeWithMocks({ complete });

    await codexGenerateText({
      messages: [{ role: "user", content: "hi" }],
      tools: tools as never,
      modelId: "gpt-5.4",
      profileName: "openai-codex",
    });

    expect(execute).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(2);
    const toolMsg = conversations[1].messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(JSON.stringify(toolMsg!.content)).toContain("error-text");
    expect(JSON.stringify(toolMsg!.content)).toContain("Invalid arguments");
  });

  it("executes the tool with validated arguments when the schema matches", async () => {
    const execute = vi.fn(async (input: { minutes: number }) => `logged ${input.minutes}`);
    const tools = {
      log_ride: {
        description: "log a ride",
        inputSchema: zodSchema(z.object({ minutes: z.number() })),
        execute,
      },
    };

    const conversations: Array<{ messages: Array<Record<string, unknown>> }> = [];
    const complete = vi.fn(async (params: { messages: Array<Record<string, unknown>> }) => {
      conversations.push({ messages: [...params.messages] });
      if (conversations.length === 1) {
        return asstMsg({
          stopReason: "toolUse",
          toolCalls: [{ id: "c1", name: "log_ride", arguments: { minutes: 60 } }],
        });
      }
      return asstMsg();
    });
    const { codexGenerateText } = await loadBridgeWithMocks({ complete });

    await codexGenerateText({
      messages: [{ role: "user", content: "hi" }],
      tools: tools as never,
      modelId: "gpt-5.4",
      profileName: "openai-codex",
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toEqual({ minutes: 60 });
    const toolMsg = conversations[1].messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(JSON.stringify(toolMsg!.content)).toContain("logged 60");
  });

  it("forwards opts.signal to codex tool execution", async () => {
    let toolOptions: { abortSignal?: AbortSignal } | undefined;
    const execute = vi.fn(async (_input: { minutes: number }, options: { abortSignal?: AbortSignal }) => {
      toolOptions = options;
      return "logged";
    });
    const tools = {
      log_ride: {
        description: "log a ride",
        inputSchema: zodSchema(z.object({ minutes: z.number() })),
        execute,
      },
    };
    const complete = vi.fn(async (params: { messages: Array<Record<string, unknown>> }) => {
      const hasToolResult = params.messages.some((m) => m.role === "tool");
      if (!hasToolResult) {
        return asstMsg({
          stopReason: "toolUse",
          toolCalls: [{ id: "c1", name: "log_ride", arguments: { minutes: 60 } }],
        });
      }
      return asstMsg();
    });
    const { codexGenerateText } = await loadBridgeWithMocks({ complete });
    const signal = new AbortController().signal;

    await codexGenerateText({
      messages: [{ role: "user", content: "hi" }],
      tools: tools as never,
      modelId: "gpt-5.4",
      profileName: "openai-codex",
      signal,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(toolOptions?.abortSignal).toBe(signal);
  });

  it("does not leak fake tokens via console.warn/error", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const secretToken = "fresh-token-abc-secret";
    const complete = vi.fn(async () => asstMsg());
    const { codexGenerateText } = await loadBridgeWithMocks({
      complete,
      freshToken: vi.fn(async () => secretToken),
    });

    await codexGenerateText({
      messages: [{ role: "user", content: "hi" }],
      modelId: "gpt-5.4",
      profileName: "openai-codex",
    });

    const allLogs = [...warnSpy.mock.calls, ...errSpy.mock.calls]
      .flat()
      .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
      .join(" ");
    expect(allLogs).not.toContain(secretToken);
    expect(allLogs).not.toContain("test-access-token");
  });
});

// normalizeError is the single classifier-feeding entry point. The codex
// round-trip throws structured errors (httpStatus / retryAfterMs carrier, or a
// raw fetch throw with an errno cause); these assert each maps to the class the
// outer retry loop expects, independent of transport.
describe("codex-bridge normalizeError", () => {
  function httpError(status: number, message = "boom", retryAfterMs?: number): Error {
    const e = new Error(message) as Error & { httpStatus?: number; retryAfterMs?: number };
    e.httpStatus = status;
    if (retryAfterMs !== undefined) e.retryAfterMs = retryAfterMs;
    return e;
  }

  it("classifies a 5xx as server error, not rate limit", () => {
    for (const status of [500, 502, 503, 504]) {
      const normalized = normalizeError(httpError(status));
      expect(isServerError(normalized)).toBe(true);
      expect(isRateLimitError(normalized)).toBe(false);
    }
  });

  it("keeps a 429 as rate limit, not server error", () => {
    const normalized = normalizeError(httpError(429, "quota exhausted (status=429)"));
    expect(isRateLimitError(normalized)).toBe(true);
    expect(isServerError(normalized)).toBe(false);
  });

  it("preserves a carried retryAfterMs on the normalized error", () => {
    const normalized = normalizeError(httpError(503, "boom", 7000)) as Error & {
      retryAfterMs?: number;
    };
    expect(normalized.retryAfterMs).toBe(7000);
  });

  it("classifies a raw thrown fetch (errno cause) as network, not rate limit", () => {
    const original = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNRESET" },
    });
    const normalized = normalizeError(original);
    expect(isNetworkError(normalized)).toBe(true);
    expect(isRateLimitError(normalized)).toBe(false);
  });
});
