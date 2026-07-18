import { describe, it, expect } from "vitest";
import { priceUsage, isPriced, PRICE_TABLE } from "../../src/agent/codex/cost.js";

describe("codex cost", () => {
  it("prices a catalogued codex model (gpt-5.4) at the per-million rate", () => {
    const cost = priceUsage("openai-codex", "gpt-5.4", {
      input: 1_000_000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(cost).toBeDefined();
    // gpt-5.4 input rate is 2.5 / 1e6 → 1,000,000 tokens = exactly 2.5.
    expect(cost?.input).toBeCloseTo(2.5, 10);
    expect(cost?.total).toBeCloseTo(2.5, 10);
  });

  it("prices a catalogued anthropic model", () => {
    const entry = Object.entries(PRICE_TABLE.anthropic).find(([, c]) => c.input > 0);
    expect(entry).toBeDefined();
    const [id, c] = entry!;
    const cost = priceUsage("anthropic", id, {
      input: 1_000_000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(cost?.input).toBeCloseTo(c.input, 10);
  });

  it("returns undefined on a table miss (uncatalogued model or provider)", () => {
    expect(
      priceUsage("anthropic", "claude-not-real", {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
      }),
    ).toBeUndefined();
    expect(
      priceUsage("deepseek", "deepseek-v4-flash", {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
      }),
    ).toBeUndefined();
    // priceUsage itself does not fall back unknown codex ids; the bridge does.
    expect(
      priceUsage("openai-codex", "gpt-5.4-pro", {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
      }),
    ).toBeUndefined();
  });

  it("isPriced reflects table membership", () => {
    expect(isPriced("openai-codex", "gpt-5.4")).toBe(true);
    expect(isPriced("anthropic", "claude-not-real")).toBe(false);
    expect(isPriced("deepseek", "anything")).toBe(false);
  });

  it("computes the rolled-up total as the sum of the four dimensions", () => {
    const cost = priceUsage("openai-codex", "gpt-5.4", {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
    });
    // (2.5*10 + 15*5)/1e6 = 0.0001
    expect(cost?.total).toBeCloseTo(0.0001, 12);
    expect(cost?.total).toBeCloseTo(
      cost!.input + cost!.output + cost!.cacheRead + cost!.cacheWrite,
      15,
    );
  });
});
