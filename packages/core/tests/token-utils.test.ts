import { describe, it, expect } from "vitest";
import { APICallError } from "@ai-sdk/provider";
import type { LanguageModelUsage, ModelMessage } from "ai";
import {
  messageText,
  estimateTokens,
  estimateMessagesTokens,
  estimatePromptTokens,
  computeHistoryTokenBudget,
  shouldCompact,
  classifyFailure,
  isContextOverflowError,
  isWindowExceededFinish,
  effectiveEstimatorWindowTokens,
  MAX_EFFECTIVE_WINDOW_ESTIMATOR_TOKENS,
  formatRateLimitWait,
} from "../src/agent/token-utils.js";

function apiError(statusCode: number): APICallError {
  return new APICallError({
    message: "api error",
    url: "https://example.test",
    requestBodyValues: {},
    statusCode,
  });
}

function rateLimitError(retryAfterSeconds: number): APICallError {
  return new APICallError({
    message: "rate limited",
    url: "https://example.test",
    requestBodyValues: {},
    statusCode: 429,
    responseHeaders: { "retry-after": String(retryAfterSeconds) },
  });
}

const msg = (chars: number): ModelMessage => ({ role: "user", content: "x".repeat(chars) });

describe("estimateTokens", () => {
  it("pins the chars/4 x 1.2 formula", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(2);
    expect(estimateTokens("x".repeat(40))).toBe(12);
    expect(estimateTokens("x".repeat(400))).toBe(120);
  });
});

describe("messageText", () => {
  it("returns string content verbatim and concatenates text parts", () => {
    expect(messageText({ role: "user", content: "hello" })).toBe("hello");
    expect(
      messageText({
        role: "user",
        content: [
          { type: "text", text: "hi" },
          { type: "text", text: " there" },
        ],
      }),
    ).toBe("hi there");
  });

  it("serializes non-text structured parts instead of dropping them to zero", () => {
    const toolMsg = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "intervals_get",
          output: { type: "text", value: "a big structured payload" },
        },
      ],
    } as unknown as ModelMessage;
    const text = messageText(toolMsg);
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("tool-result");
  });
});

describe("estimateMessagesTokens", () => {
  it("counts text-part content instead of dropping it to zero", () => {
    expect(estimateMessagesTokens([msg(400), msg(400)])).toBe(240);
    expect(
      estimateMessagesTokens([
        msg(400),
        { role: "user", content: [{ type: "text", text: "x".repeat(400) }] },
      ]),
    ).toBe(240);
  });
});

describe("computeHistoryTokenBudget", () => {
  it("computes window x ratio minus system-prompt tokens minus the reserve", () => {
    expect(
      computeHistoryTokenBudget({
        contextWindowTokens: 200_000,
        systemPrompt: "x".repeat(4000),
        budgetRatio: 0.3,
      }),
    ).toBe(38_800);
  });

  it("floors at 8,000 tokens", () => {
    expect(
      computeHistoryTokenBudget({
        contextWindowTokens: 100_000,
        systemPrompt: "x".repeat(8000),
        budgetRatio: 0.3,
      }),
    ).toBe(8000);
    expect(
      computeHistoryTokenBudget({
        contextWindowTokens: 10_000,
        systemPrompt: "",
        budgetRatio: 0.3,
      }),
    ).toBe(8000);
  });
});

describe("classifyFailure", () => {
  it("classifies 5xx status codes (incl 529) as server_error", () => {
    for (const status of [500, 502, 503, 504, 529]) {
      expect(classifyFailure(apiError(status))).toBe("server_error");
    }
  });

  it("classifies 429 as rate_limit", () => {
    expect(classifyFailure(apiError(429))).toBe("rate_limit");
  });

  it("classifies 401/403 as auth", () => {
    expect(classifyFailure(apiError(401))).toBe("auth");
    expect(classifyFailure(apiError(403))).toBe("auth");
  });

  it("classifies 400 as invalid_request", () => {
    expect(classifyFailure(apiError(400))).toBe("invalid_request");
  });

  it("classifies a fetch-failed TypeError with a network code on .cause as network", () => {
    const e = new TypeError("fetch failed");
    (e as Error & { cause?: unknown }).cause = { code: "ECONNREFUSED" };
    expect(classifyFailure(e)).toBe("network");
  });

  it("classifies a top-level connection-code error as network", () => {
    const e = Object.assign(new Error("conn reset"), { code: "ECONNRESET" });
    expect(classifyFailure(e)).toBe("network");
  });

  it("resolves a top-level ETIMEDOUT to timeout, not network (precedence)", () => {
    const e = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
    expect(classifyFailure(e)).toBe("timeout");
  });

  it("classifies a context-overflow message as overflow", () => {
    expect(classifyFailure(new Error("maximum context length exceeded"))).toBe("overflow");
  });

  it("classifies an unmatched error as unknown", () => {
    expect(classifyFailure(new Error("???"))).toBe("unknown");
  });
});

describe("formatRateLimitWait", () => {
  it("returns 'about a minute' when no retry-after header is present", () => {
    expect(formatRateLimitWait(new Error("rate limited"))).toBe("about a minute");
    expect(formatRateLimitWait(apiError(429))).toBe("about a minute");
  });

  it("returns '~Ns' for a sub-minute retry-after", () => {
    expect(formatRateLimitWait(rateLimitError(30))).toBe("~30 seconds");
  });

  it("returns '~N minute(s)' for a >=60s retry-after", () => {
    expect(formatRateLimitWait(rateLimitError(90))).toBe("~2 minutes");
    expect(formatRateLimitWait(rateLimitError(60))).toBe("~1 minute");
  });

  it("is importable from token-utils.js", () => {
    expect(typeof formatRateLimitWait).toBe("function");
  });
});

describe("shouldCompact", () => {
  it("is strict at the boundary and counts the system prompt", () => {
    expect(
      shouldCompact({ messages: [msg(4000)], systemPrompt: "", contextWindowTokens: 21_200 }),
    ).toBe(false);
    expect(
      shouldCompact({ messages: [msg(4000)], systemPrompt: "", contextWindowTokens: 21_199 }),
    ).toBe(true);
    expect(
      shouldCompact({ messages: [msg(4000)], systemPrompt: "xxxx", contextWindowTokens: 21_200 }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Effective estimator-window cap
// ---------------------------------------------------------------------------

describe("effectiveEstimatorWindowTokens", () => {
  it("caps at 200k and leaves smaller windows unchanged", () => {
    expect(MAX_EFFECTIVE_WINDOW_ESTIMATOR_TOKENS).toBe(200_000);
    expect(effectiveEstimatorWindowTokens(1_000_000)).toBe(200_000);
    expect(effectiveEstimatorWindowTokens(200_000)).toBe(200_000);
    expect(effectiveEstimatorWindowTokens(128_000)).toBe(128_000);
  });
});

describe("history budget / preemptive compaction use min(window, 200k)", () => {
  it("computeHistoryTokenBudget caps a 1M window at the 200k effective window", () => {
    const capped = computeHistoryTokenBudget({
      contextWindowTokens: 1_000_000,
      systemPrompt: "",
      budgetRatio: 0.3,
    });
    const atCap = computeHistoryTokenBudget({
      contextWindowTokens: 200_000,
      systemPrompt: "",
      budgetRatio: 0.3,
    });
    // 200_000 * 0.3 - 0 - 20_000 = 40_000, not 1M * 0.3.
    expect(capped).toBe(40_000);
    expect(capped).toBe(atCap);
  });

  it("computeHistoryTokenBudget leaves a sub-200k window unchanged", () => {
    expect(
      computeHistoryTokenBudget({ contextWindowTokens: 128_000, systemPrompt: "", budgetRatio: 0.3 }),
    ).toBe(128_000 * 0.3 - 20_000);
  });

  it("shouldCompact treats a 1M window as the 200k effective window", () => {
    // 210k estimator-tokens: over the 200k-20k budget, but well under a raw 1M window.
    const big = [msg(700_000)];
    expect(estimateMessagesTokens(big)).toBe(210_000);
    expect(
      shouldCompact({ messages: big, systemPrompt: "", contextWindowTokens: 1_000_000 }),
    ).toBe(true);
    expect(
      shouldCompact({ messages: big, systemPrompt: "", contextWindowTokens: 200_000 }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Usage-anchored estimator
// ---------------------------------------------------------------------------

describe("estimatePromptTokens usage anchor", () => {
  it("falls back to the pure char estimate when no anchor is supplied", () => {
    expect(estimatePromptTokens({ messages: [msg(400)], systemPrompt: "" })).toBe(120);
  });

  it("anchors to the provider token count for messages the model already saw", () => {
    // Non-Latin content is tokenized far denser than chars/4; the provider anchor
    // (12_000 real tokens) yields a safer estimate than the char estimate alone.
    const seen = [msg(400), msg(400)]; // char estimate 240
    const sinceAnchor = [msg(400)]; // 120
    const anchored = estimatePromptTokens({
      messages: [...seen, ...sinceAnchor],
      systemPrompt: "",
      lastUsageTokens: 12_000,
      messagesSinceUsageAnchor: sinceAnchor,
    });
    expect(anchored).toBe(12_000 + 120);
  });

  it("never drops below the char estimate even when the anchor is smaller", () => {
    const messages = [msg(400), msg(400)]; // char estimate 240
    expect(
      estimatePromptTokens({
        messages,
        systemPrompt: "",
        lastUsageTokens: 10,
        messagesSinceUsageAnchor: [],
      }),
    ).toBe(240);
  });

  it("makes shouldCompact fire earlier once a large provider anchor is known", () => {
    const messages = [msg(400)]; // char estimate 120 — nowhere near a 200k budget
    expect(
      shouldCompact({ messages, systemPrompt: "", contextWindowTokens: 200_000 }),
    ).toBe(false);
    expect(
      shouldCompact({
        messages,
        systemPrompt: "",
        contextWindowTokens: 200_000,
        lastUsageTokens: 190_000,
        messagesSinceUsageAnchor: messages,
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Context-overflow classification
// ---------------------------------------------------------------------------

function overflowApiError(data: unknown, statusCode = 400): APICallError {
  return new APICallError({
    message: "invalid request",
    url: "https://example.test",
    requestBodyValues: {},
    statusCode,
    data,
  });
}

const usage = (inputTokens: number): LanguageModelUsage =>
  ({ inputTokens, outputTokens: 0, totalTokens: inputTokens }) as unknown as LanguageModelUsage;

describe("isContextOverflowError", () => {
  it("treats a Codex-normalized ContextOverflowError name as authoritative", () => {
    const e = new Error("Context overflow: exceeds the maximum context length");
    e.name = "ContextOverflowError";
    expect(isContextOverflowError(e)).toBe(true);
  });

  it("classifies an OpenAI 400 context_length_exceeded body as overflow", () => {
    const err = overflowApiError({
      error: {
        message: "This model's maximum context length is 128000 tokens. However your messages resulted in 140000 tokens.",
        type: "invalid_request_error",
        code: "context_length_exceeded",
      },
    });
    expect(isContextOverflowError(err)).toBe(true);
    expect(classifyFailure(err)).toBe("overflow");
  });

  it("classifies an Anthropic 400 'prompt is too long' body as overflow", () => {
    const err = overflowApiError({
      type: "error",
      error: { type: "invalid_request_error", message: "prompt is too long: 250000 tokens > 200000 maximum" },
    });
    expect(isContextOverflowError(err)).toBe(true);
    expect(classifyFailure(err)).toBe("overflow");
  });

  it("classifies a Google 400 'input token count exceeds the maximum' body as overflow", () => {
    const err = overflowApiError({
      error: {
        code: 400,
        message: "The input token count (1050000) exceeds the maximum number of tokens allowed (1048576).",
        status: "INVALID_ARGUMENT",
      },
    });
    expect(isContextOverflowError(err)).toBe(true);
    expect(classifyFailure(err)).toBe("overflow");
  });

  it("does NOT classify a generic 400 invalid request as overflow", () => {
    const err = overflowApiError({
      error: { type: "invalid_request_error", message: "Invalid value for 'temperature': must be <= 2." },
    });
    expect(isContextOverflowError(err)).toBe(false);
    expect(classifyFailure(err)).toBe("invalid_request");
  });

  it("preserves plain message-substring classification for non-SDK errors", () => {
    expect(isContextOverflowError(new Error("maximum context length exceeded"))).toBe(true);
    expect(isContextOverflowError(new Error("something unrelated"))).toBe(false);
  });
});

describe("isWindowExceededFinish", () => {
  it("flags a length finish whose input tokens fill the real window", () => {
    expect(
      isWindowExceededFinish({ finishReason: "length", usage: usage(272_000), contextWindowTokens: 272_000 }),
    ).toBe(true);
  });

  it("does not flag a plain length finish with room left in the window", () => {
    expect(
      isWindowExceededFinish({ finishReason: "length", usage: usage(5_000), contextWindowTokens: 272_000 }),
    ).toBe(false);
  });

  it("only fires on a length finish, and never without usage", () => {
    expect(
      isWindowExceededFinish({ finishReason: "stop", usage: usage(999_999), contextWindowTokens: 272_000 }),
    ).toBe(false);
    expect(
      isWindowExceededFinish({ finishReason: "length", usage: undefined, contextWindowTokens: 272_000 }),
    ).toBe(false);
  });
});
