import { describe, expect, it } from "vitest";

import {
  CODEX_AGENT_FALLBACK_PRICE_ID,
  CODEX_AGENT_PRICE_TABLE,
  codexAgentCacheReadSavingsUsd,
  codexAgentRates,
  priceCodexAgentInclusiveUsage,
  resolveCodexAgentPriceId,
} from "../../src/agent/codex-agent/cost.js";

const USAGE = {
  inputTokens: 1_000_000,
  outputTokens: 100_000,
  cacheReadTokens: 400_000,
  cacheWriteTokens: 100_000,
};

describe("codex-agent price ids (AC-13)", () => {
  it("prices the three catalogued model ids exactly", () => {
    expect(Object.keys(CODEX_AGENT_PRICE_TABLE).sort()).toEqual([
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
    ]);
    expect(resolveCodexAgentPriceId("gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(resolveCodexAgentPriceId("gpt-5.6-terra")).toBe("gpt-5.6-terra");
    expect(resolveCodexAgentPriceId("gpt-5.6-luna")).toBe("gpt-5.6-luna");
  });

  it("falls back by family substring so a future model id still prices", () => {
    expect(resolveCodexAgentPriceId("gpt-5.9-terra-preview")).toBe("gpt-5.6-terra");
    expect(resolveCodexAgentPriceId("GPT-5.9-LUNA")).toBe("gpt-5.6-luna");
    expect(resolveCodexAgentPriceId("gpt-6.0-quasar")).toBe(CODEX_AGENT_FALLBACK_PRICE_ID);
    expect(resolveCodexAgentPriceId("")).toBe(CODEX_AGENT_FALLBACK_PRICE_ID);
    expect(codexAgentRates("gpt-6.0-quasar")).toEqual(CODEX_AGENT_PRICE_TABLE["gpt-5.6-sol"]);
  });
});

describe("priceCodexAgentInclusiveUsage (AC-13)", () => {
  it("treats inputTokens as inclusive of cached reads and writes", () => {
    const priced = priceCodexAgentInclusiveUsage("gpt-5.6-sol", USAGE);
    const rates = CODEX_AGENT_PRICE_TABLE["gpt-5.6-sol"];
    expect(rates).toBeDefined();
    if (rates === undefined || priced === undefined) return;

    const uncached = USAGE.inputTokens - USAGE.cacheReadTokens - USAGE.cacheWriteTokens;
    expect(priced.input).toBeCloseTo((rates.input / 1_000_000) * uncached, 12);
    expect(priced.output).toBeCloseTo((rates.output / 1_000_000) * USAGE.outputTokens, 12);
    expect(priced.cacheRead).toBeCloseTo((rates.cacheRead / 1_000_000) * USAGE.cacheReadTokens, 12);
    expect(priced.cacheWrite).toBeCloseTo(
      (rates.cacheWrite / 1_000_000) * USAGE.cacheWriteTokens,
      12,
    );
    expect(priced.total).toBeCloseTo(
      priced.input + priced.output + priced.cacheRead + priced.cacheWrite,
      12,
    );
  });

  it("never returns a negative uncached component when cached exceeds input", () => {
    const priced = priceCodexAgentInclusiveUsage("gpt-5.6-luna", {
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 400,
      cacheWriteTokens: 50,
    });
    expect(priced?.input).toBe(0);
    expect(priced?.total).toBeGreaterThan(0);
  });

  it("prices an uncatalogued id at the family fallback rather than returning undefined", () => {
    const fallback = priceCodexAgentInclusiveUsage("gpt-5.9-sol-preview", USAGE);
    expect(fallback).toBeDefined();
    expect(fallback).toEqual(priceCodexAgentInclusiveUsage("gpt-5.6-sol", USAGE));
  });

  it("rejects malformed token counts", () => {
    for (const usage of [
      { ...USAGE, inputTokens: -1 },
      { ...USAGE, outputTokens: 1.5 },
      { ...USAGE, cacheReadTokens: Number.NaN },
      { ...USAGE, cacheWriteTokens: Number.POSITIVE_INFINITY },
    ]) {
      expect(priceCodexAgentInclusiveUsage("gpt-5.6-sol", usage)).toBeUndefined();
    }
  });
});

describe("codexAgentCacheReadSavingsUsd (AC-13)", () => {
  it("values a cache read at the difference between input and cache-read rates", () => {
    const rates = CODEX_AGENT_PRICE_TABLE["gpt-5.6-sol"];
    expect(rates).toBeDefined();
    if (rates === undefined) return;
    expect(codexAgentCacheReadSavingsUsd("gpt-5.6-sol", 400_000)).toBeCloseTo(
      ((rates.input - rates.cacheRead) * 400_000) / 1_000_000,
      12,
    );
  });

  it("uses the family fallback for an uncatalogued id and rejects malformed counts", () => {
    expect(codexAgentCacheReadSavingsUsd("gpt-5.9-terra-preview", 500_000)).toBe(
      codexAgentCacheReadSavingsUsd("gpt-5.6-terra", 500_000),
    );
    expect(codexAgentCacheReadSavingsUsd("gpt-5.6-sol", -1)).toBeNull();
    expect(codexAgentCacheReadSavingsUsd("gpt-5.6-sol", 1.5)).toBeNull();
  });
});
