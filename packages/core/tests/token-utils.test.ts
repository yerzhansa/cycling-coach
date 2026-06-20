import { describe, it, expect } from "vitest";
import { APICallError } from "@ai-sdk/provider";
import type { ModelMessage } from "ai";
import {
  messageText,
  estimateTokens,
  estimateMessagesTokens,
  computeHistoryTokenBudget,
  shouldCompact,
  classifyFailure,
} from "../src/agent/token-utils.js";

function apiError(statusCode: number): APICallError {
  return new APICallError({
    message: "api error",
    url: "https://example.test",
    requestBodyValues: {},
    statusCode,
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
  it("returns string content verbatim and \"\" for part-array content", () => {
    expect(messageText({ role: "user", content: "hello" })).toBe("hello");
    expect(messageText({ role: "user", content: [{ type: "text", text: "hi" }] })).toBe("");
  });
});

describe("estimateMessagesTokens", () => {
  it("sums per-message estimates, with part-array messages contributing 0", () => {
    expect(estimateMessagesTokens([msg(400), msg(400)])).toBe(240);
    expect(
      estimateMessagesTokens([
        msg(400),
        { role: "user", content: [{ type: "text", text: "x".repeat(400) }] },
      ]),
    ).toBe(120);
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
