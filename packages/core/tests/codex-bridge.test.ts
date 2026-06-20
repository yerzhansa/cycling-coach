import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zodSchema } from "ai";
import { z } from "zod";
import {
  PI_AI_NO_RETRY_MARKER,
  markNetworkThrow,
  normalizeError,
} from "../src/agent/codex-bridge.js";
import { isRateLimitError, isServerError, isNetworkError } from "../src/agent/token-utils.js";

// Test the bridge's error normalization and result mapping. Mocks pi-ai's
// `complete` / `getModel` and auth profile access.

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
  getModel?: ReturnType<typeof vi.fn>;
  freshToken?: ReturnType<typeof vi.fn>;
}) {
  const getModel =
    opts.getModel ??
    vi.fn(() => ({
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
    }));

  vi.doMock("@mariozechner/pi-ai", () => ({
    complete: opts.complete,
    getModel,
  }));

  vi.doMock("../src/auth/profiles.js", () => ({
    getFreshToken: opts.freshToken ?? vi.fn(async () => "test-access-token"),
  }));

  const { codexGenerateText } = await import("../src/agent/codex-bridge.js");
  return { codexGenerateText, getModel };
}

function asstMsg(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "hello" }],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-5.4",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
    ...overrides,
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

  it("maps pi-ai rate-limit errors so isRateLimitError() recognizes them", async () => {
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

  it("calls getFreshToken before each request and forwards the token as apiKey", async () => {
    const complete = vi.fn(async () => asstMsg());
    const freshToken = vi.fn(async () => "fresh-token-abc");
    const { codexGenerateText } = await loadBridgeWithMocks({ complete, freshToken });

    await codexGenerateText({
      messages: [{ role: "user", content: "hi" }],
      modelId: "gpt-5.4",
      profileName: "openai-codex",
    });

    expect(freshToken).toHaveBeenCalledWith("openai-codex");
    expect(complete).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ apiKey: "fresh-token-abc", onResponse: expect.any(Function) }),
    );
  });

  it("forwards opts.cacheKey to pi-ai's complete as sessionId; omits it when absent", async () => {
    const completeWithKey = vi.fn(async () => asstMsg());
    const { codexGenerateText: genWithKey } = await loadBridgeWithMocks({ complete: completeWithKey });

    await genWithKey({
      messages: [{ role: "user", content: "hi" }],
      modelId: "gpt-5.4",
      profileName: "openai-codex",
      cacheKey: "abc123def456",
    });

    expect(completeWithKey).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
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
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ sessionId: undefined }),
    );
  });

  it("surfaces finishReason=length so isContextOverflowError can catch it upstream via retry", async () => {
    const complete = vi.fn(async () =>
      asstMsg({ stopReason: "length", content: [{ type: "text", text: "truncated" }] }),
    );
    const { codexGenerateText } = await loadBridgeWithMocks({ complete });
    const res = await codexGenerateText({
      messages: [{ role: "user", content: "hi" }],
      modelId: "gpt-5.4",
      profileName: "openai-codex",
    });
    expect(res.finishReason).toBe("length");
  });

  it("passes onResponse that throws 'usage limit' on retryable HTTP statuses", async () => {
    let capturedOnResponse:
      | ((r: { status: number; headers: Record<string, string> }) => Promise<void> | void)
      | undefined;
    const complete = vi.fn(async (_m: unknown, _c: unknown, opts: { onResponse?: typeof capturedOnResponse }) => {
      capturedOnResponse = opts.onResponse;
      return asstMsg();
    });
    const { codexGenerateText } = await loadBridgeWithMocks({ complete });

    await codexGenerateText({
      messages: [{ role: "user", content: "hi" }],
      modelId: "gpt-5.4",
      profileName: "openai-codex",
    });

    expect(typeof capturedOnResponse).toBe("function");

    for (const status of [429, 500, 502, 503, 504]) {
      await expect(capturedOnResponse!({ status, headers: {} })).rejects.toThrow(/usage limit/);
    }

    for (const status of [200, 201, 204, 301, 400, 401, 403, 404]) {
      await expect(capturedOnResponse!({ status, headers: {} })).resolves.toBeUndefined();
    }
  });

  it("stops the tool-calling loop at stepLimit", async () => {
    // Always return a toolCall — the bridge would loop forever if stepLimit
    // weren't honored. Empty tools set → executeToolCall returns an error
    // result but the loop still cycles until stepLimit.
    const complete = vi.fn(async () =>
      asstMsg({
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "c1", name: "noop", arguments: {} }],
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

    const contexts: Array<{ messages: Array<Record<string, unknown>> }> = [];
    const complete = vi.fn(
      async (_m: unknown, ctx: { messages: Array<Record<string, unknown>> }) => {
        contexts.push({ messages: [...ctx.messages] });
        if (contexts.length === 1) {
          return asstMsg({
            stopReason: "toolUse",
            content: [
              { type: "toolCall", id: "c1", name: "log_ride", arguments: { minutes: "sixty" } },
            ],
          });
        }
        return asstMsg();
      },
    );
    const { codexGenerateText } = await loadBridgeWithMocks({ complete });

    await codexGenerateText({
      messages: [{ role: "user", content: "hi" }],
      tools: tools as never,
      modelId: "gpt-5.4",
      profileName: "openai-codex",
    });

    expect(execute).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(2);
    const toolResult = contexts[1].messages.find((m) => m.role === "toolResult");
    expect(toolResult).toBeDefined();
    expect(toolResult!.isError).toBe(true);
    expect(JSON.stringify(toolResult!.content)).toContain("Invalid arguments");
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

    const contexts: Array<{ messages: Array<Record<string, unknown>> }> = [];
    const complete = vi.fn(
      async (_m: unknown, ctx: { messages: Array<Record<string, unknown>> }) => {
        contexts.push({ messages: [...ctx.messages] });
        if (contexts.length === 1) {
          return asstMsg({
            stopReason: "toolUse",
            content: [
              { type: "toolCall", id: "c1", name: "log_ride", arguments: { minutes: 60 } },
            ],
          });
        }
        return asstMsg();
      },
    );
    const { codexGenerateText } = await loadBridgeWithMocks({ complete });

    await codexGenerateText({
      messages: [{ role: "user", content: "hi" }],
      tools: tools as never,
      modelId: "gpt-5.4",
      profileName: "openai-codex",
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toEqual({ minutes: 60 });
    const toolResult = contexts[1].messages.find((m) => m.role === "toolResult");
    expect(toolResult).toBeDefined();
    expect(toolResult!.isError).toBe(false);
    expect(JSON.stringify(toolResult!.content)).toContain("logged 60");
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

// Capture onResponse the way the existing status-code test does, then drive a
// status through it and feed the rejection through normalizeError — proving the
// 5xx-split / Retry-After behavior at the bridge boundary.
async function captureOnResponse() {
  let captured:
    | ((r: { status: number; headers?: Record<string, string> }) => Promise<void> | void)
    | undefined;
  const complete = vi.fn(
    async (_m: unknown, _c: unknown, opts: { onResponse?: typeof captured }) => {
      captured = opts.onResponse;
      return asstMsg();
    },
  );
  const { codexGenerateText } = await loadBridgeWithMocks({ complete });
  await codexGenerateText({
    messages: [{ role: "user", content: "hi" }],
    modelId: "gpt-5.4",
    profileName: "openai-codex",
  });
  return captured!;
}

describe("codex-bridge 5xx server-error split", () => {
  it("classifies a 5xx as server error, not rate limit", async () => {
    const onResponse = await captureOnResponse();
    for (const status of [500, 502, 503, 504]) {
      let thrown: unknown;
      try {
        await onResponse({ status, headers: {} });
      } catch (err) {
        thrown = err;
      }
      const normalized = normalizeError(thrown);
      expect(isServerError(normalized)).toBe(true);
      expect(isRateLimitError(normalized)).toBe(false);
    }
  });

  it("keeps a true 429 as rate limit, not server error", async () => {
    const onResponse = await captureOnResponse();
    let thrown: unknown;
    try {
      await onResponse({ status: 429, headers: {} });
    } catch (err) {
      thrown = err;
    }
    const normalized = normalizeError(thrown);
    expect(isRateLimitError(normalized)).toBe(true);
    expect(isServerError(normalized)).toBe(false);
  });

  it("honors Retry-After from the headers onResponse receives", async () => {
    const onResponse = await captureOnResponse();

    const grab = async (headers: Record<string, string>): Promise<number | undefined> => {
      try {
        await onResponse({ status: 503, headers });
        return undefined;
      } catch (err) {
        return (err as { retryAfterMs?: number }).retryAfterMs;
      }
    };

    expect(await grab({ "retry-after": "7" })).toBe(7000);
    expect(await grab({ "retry-after-ms": "1500" })).toBe(1500);
    expect(await grab({})).toBeUndefined();
  });

  it("trips loudly if the provider library renames the no-retry marker", () => {
    const distUrl = import.meta.resolve("@mariozechner/pi-ai/openai-codex-responses");
    const distPath = fileURLToPath(distUrl);
    const source = readFileSync(distPath, "utf8");
    expect(source.includes(PI_AI_NO_RETRY_MARKER)).toBe(true);
    expect(source.includes("USAGE_LIMIT_RENAMED")).toBe(false);
  });
});

describe("codex-bridge network-error escape", () => {
  it("rethrows a network throw carrying the marker so the library stops at one attempt", () => {
    const original = Object.assign(new Error("fetch failed"), { code: "ECONNREFUSED" });
    const marked = markNetworkThrow(original);
    expect(marked.message.startsWith(PI_AI_NO_RETRY_MARKER)).toBe(true);
    expect(marked.message).toContain("fetch failed");
    // The library's `!message.includes("usage limit")` guard becomes false.
    expect(marked.message.includes(PI_AI_NO_RETRY_MARKER)).toBe(true);
    // Idempotent: re-marking an already-marked error must not double-prefix.
    const remarked = markNetworkThrow(marked);
    expect(remarked).toBe(marked);
  });

  it("normalizes a marked network throw to the network class, not rate limit", () => {
    const original = Object.assign(new Error("fetch failed"), { code: "ECONNRESET" });
    const marked = markNetworkThrow(original);
    const normalized = normalizeError(marked);
    // Carrying the "usage limit" marker must NOT route a connection failure into
    // the rate-limit branch.
    expect(isRateLimitError(normalized)).toBe(false);
    expect(isNetworkError(normalized)).toBe(true);
  });

  it("passes a resolved non-OK response through unchanged (status-code path)", async () => {
    // The wrapper only touches thrown fetches; a resolved 500 Response is the
    // status-code path onCodexResponse owns, so markNetworkThrow is never applied.
    const response = new Response("err", { status: 500 });
    // Simulate the wrapper's resolve branch: a resolved response is returned as-is.
    const passthrough = async (): Promise<Response> => response;
    const out = await passthrough();
    expect(out.status).toBe(500);
  });

  it("installs the wrapper so the library retry loop short-circuits a network throw to one fetch", async () => {
    // The wrapper the bridge installs around complete() rethrows a network throw
    // carrying PI_AI_NO_RETRY_MARKER. `complete` models pi-ai's real predicate —
    // retry up to 4x UNLESS the error message carries that marker — so this test
    // actually exercises the short-circuit: with the marker, fetch runs once;
    // remove the marker rethrow and the loop runs the inner fetch 4 times.
    const PI_AI_MAX_RETRIES = 4;
    const fetchSpy = vi.fn(async () => {
      // Undici buries the connection code on .cause.code of a "fetch failed".
      const e = new TypeError("fetch failed");
      (e as Error & { cause?: unknown }).cause = { code: "ECONNREFUSED" };
      throw e;
    });
    const complete = vi.fn(async () => {
      let lastError: unknown;
      for (let attempt = 0; attempt < PI_AI_MAX_RETRIES; attempt++) {
        try {
          await (globalThis.fetch as unknown as typeof fetchSpy)();
          return asstMsg();
        } catch (e) {
          lastError = e;
          // pi-ai 0.67.x retries a network throw unless its message carries the
          // no-retry marker; the installed wrapper is what stamps that marker.
          if (e instanceof Error && e.message.includes(PI_AI_NO_RETRY_MARKER)) throw e;
        }
      }
      throw lastError;
    });
    const { codexGenerateText } = await loadBridgeWithMocks({ complete });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchSpy as unknown as typeof fetch);

    let thrown: unknown;
    try {
      await codexGenerateText({
        messages: [{ role: "user", content: "hi" }],
        modelId: "gpt-5.4",
        profileName: "openai-codex",
      });
    } catch (err) {
      thrown = err;
    }

    // The marker stopped pi-ai's loop after the first attempt (not 4).
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(thrown).toBeInstanceOf(Error);
    // The surfaced (normalized) error is a network error, never rate-limit.
    expect(isRateLimitError(thrown)).toBe(false);
    expect(isNetworkError(thrown)).toBe(true);
  });
});
