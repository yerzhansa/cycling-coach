import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
