import { describe, expect, it } from "vitest";
import {
  cacheReadSavingsUsd,
  classifySpendCaching,
  priceInclusiveUsage,
} from "../src/usage-cost.js";

describe("usage cost", () => {
  it("prices inclusive input without charging cached tokens twice", () => {
    const cost = priceInclusiveUsage("anthropic", "claude-sonnet-4-6", {
      inputTokens: 1_000,
      outputTokens: 100,
      cacheReadTokens: 400,
      cacheWriteTokens: 100,
    });
    expect(cost?.total).toBe(0.003495);
    expect(cacheReadSavingsUsd("anthropic", "claude-sonnet-4-6", 400)).toBe(0.00108);
  });

  it("rejects invalid tokens and unknown routes while preserving catalogued zero pricing", () => {
    for (const inputTokens of [-1, 1.5, NaN, Infinity]) {
      expect(
        priceInclusiveUsage("anthropic", "claude-sonnet-4-6", {
          inputTokens,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        }),
      ).toBeUndefined();
    }
    const usage = {
      inputTokens: 1_000,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    expect(priceInclusiveUsage("synthetic", "unknown", usage)).toBeUndefined();
    expect(priceInclusiveUsage("openrouter", "openrouter/auto", usage)).toBeUndefined();
    expect(cacheReadSavingsUsd("openrouter", "openrouter/auto", 100)).toBeNull();
  });

  it.each([
    ["anthropic", "claude-sonnet-4-6", "explicit"],
    ["openrouter", "qwen/synthetic", "explicit"],
    ["openrouter", "anthropic/synthetic", "unavailable"],
    ["openrouter", "google/synthetic", "unavailable"],
    ["openrouter", "openai/synthetic", "provider-dependent"],
    ["openai", "synthetic", "provider-dependent"],
    ["google", "synthetic", "provider-dependent"],
    ["deepseek", "synthetic", "provider-dependent"],
    ["qwen", "synthetic", "provider-dependent"],
    ["minimax", "synthetic", "provider-dependent"],
    ["kimi", "synthetic", "provider-dependent"],
    ["zai", "synthetic", "provider-dependent"],
    ["openai-codex", "synthetic", "provider-dependent"],
    ["synthetic", "unknown", "provider-dependent"],
  ] as const)("classifies %s/%s as %s", (provider, model, expected) => {
    expect(classifySpendCaching(provider, model)).toBe(expected);
  });
});
