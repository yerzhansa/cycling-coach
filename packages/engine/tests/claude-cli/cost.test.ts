import { describe, expect, it } from "vitest";

import {
  CLAUDE_CLI_PRICE_TABLE,
  claudeCliRates,
  priceClaudeCliInclusiveUsage,
  resolveClaudeCliPriceId,
} from "../../src/agent/claude-cli/cost.js";

const USAGE = {
  inputTokens: 1_000,
  outputTokens: 100,
  cacheReadTokens: 400,
  cacheWriteTokens: 100,
};

describe("claude-cli price ids", () => {
  it.each([
    ["sonnet", "sonnet"],
    ["opus", "opus"],
    ["haiku", "haiku"],
    ["claude-sonnet-5", "claude-sonnet-5"],
    ["claude-opus-4-5-20251101", "claude-opus-4-5-20251101"],
    ["claude-haiku-4-5", "claude-haiku-4-5"],
  ])("keeps catalogued id %s", (modelId, expected) => {
    expect(resolveClaudeCliPriceId(modelId)).toBe(expected);
  });

  it.each([
    ["claude-sonnet-9-20990101", "sonnet"],
    ["claude-opus-9", "opus"],
    ["claude-haiku-9-mini", "haiku"],
    ["Claude-Opus-Next", "opus"],
    ["sonnet[1m]", "sonnet"],
  ])("normalizes unknown id %s by family", (modelId, expected) => {
    expect(resolveClaudeCliPriceId(modelId)).toBe(expected);
  });

  it("falls back to sonnet rates for ids with no recognizable family", () => {
    expect(resolveClaudeCliPriceId("some-future-model")).toBe("sonnet");
    expect(claudeCliRates("some-future-model")).toEqual(CLAUDE_CLI_PRICE_TABLE["sonnet"]);
  });

  it("duplicates the anthropic rates for the aliases", () => {
    expect(CLAUDE_CLI_PRICE_TABLE["sonnet"]).toEqual({
      input: 2,
      output: 10,
      cacheRead: 0.2,
      cacheWrite: 2.5,
    });
    expect(CLAUDE_CLI_PRICE_TABLE["opus"]).toEqual({
      input: 5,
      output: 25,
      cacheRead: 0.5,
      cacheWrite: 6.25,
    });
    expect(CLAUDE_CLI_PRICE_TABLE["haiku"]).toEqual({
      input: 1,
      output: 5,
      cacheRead: 0.1,
      cacheWrite: 1.25,
    });
  });
});

describe("claude-cli notional pricing", () => {
  it("prices the alias without charging cached tokens twice", () => {
    const cost = priceClaudeCliInclusiveUsage("sonnet", USAGE);

    expect(cost).toEqual({
      input: (2 / 1_000_000) * 500,
      output: (10 / 1_000_000) * 100,
      cacheRead: (0.2 / 1_000_000) * 400,
      cacheWrite: (2.5 / 1_000_000) * 100,
      total: 0.0023300000000000005,
    });
  });

  it("prices a catalogued full model id at its own rates", () => {
    expect(priceClaudeCliInclusiveUsage("claude-sonnet-4-6", USAGE)?.total).toBe(0.003495);
  });

  it("prices an uncatalogued full model id at the family fallback rates", () => {
    expect(priceClaudeCliInclusiveUsage("claude-sonnet-9-20990101", USAGE)?.total).toBe(
      priceClaudeCliInclusiveUsage("sonnet", USAGE)?.total,
    );
    expect(priceClaudeCliInclusiveUsage("claude-opus-9", USAGE)?.total).toBe(
      priceClaudeCliInclusiveUsage("opus", USAGE)?.total,
    );
    expect(priceClaudeCliInclusiveUsage("totally-unknown", USAGE)?.total).toBe(
      priceClaudeCliInclusiveUsage("sonnet", USAGE)?.total,
    );
  });

  it("treats cache-heavy usage as fully cached rather than negative", () => {
    expect(
      priceClaudeCliInclusiveUsage("haiku", {
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 400,
        cacheWriteTokens: 100,
      })?.input,
    ).toBe(0);
  });

  it("rejects invalid token counts", () => {
    for (const inputTokens of [-1, 1.5, NaN, Infinity]) {
      expect(priceClaudeCliInclusiveUsage("sonnet", { ...USAGE, inputTokens })).toBeUndefined();
    }
    expect(
      priceClaudeCliInclusiveUsage("sonnet", { ...USAGE, outputTokens: -2 }),
    ).toBeUndefined();
  });
});
