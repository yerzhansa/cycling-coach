import { describe, it, expect } from "vitest";
import type { Config } from "../src/config.js";
import { LLM } from "../src/llm.js";

// A minimal Config; the LLM constructor only reads config.llm.{provider,model,apiKey,baseUrl}.
function cfg(provider: string, model: string, baseUrl?: string): Config {
  return {
    llm: { provider, model, apiKey: "sk-test-key", baseUrl },
    intervals: { apiKey: "", athleteId: "0" },
    telegram: { botToken: "" },
    session: {
      historyTokenBudgetRatio: 0.3,
      idleMinutes: 0,
      dailyResetHour: 4,
      resetArchiveRetentionDays: 0,
      timezone: "",
    },
    contextWindowTokens: 128_000,
    dataDir: "/tmp/llm-provider-build-test",
  } as Config;
}

describe("LLM — new provider construction + pricing guard", () => {
  // Construction must not throw for any new provider. For the non-KnownProvider
  // members (deepseek/qwen/kimi) this is the regression test for the TS2345
  // getModels guard: an unguarded getModels(provider) would reject these at
  // runtime; the PI_AI_PRICED narrowing routes them to a null pricing model.
  it.each([
    ["deepseek", "deepseek-v4-flash", "https://api.deepseek.com/v1"],
    ["qwen", "qwen-plus", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"],
    ["minimax", "MiniMax-M2-Stable", "https://api.minimax.io/v1"],
    ["kimi", "kimi-k2-0905", "https://api.moonshot.ai/v1"],
    ["zai", "glm-4.6", "https://api.z.ai/api/openai/v1"],
    ["openrouter", "deepseek/deepseek-chat", "https://openrouter.ai/api/v1"],
  ])("builds an AI SDK model for %s without throwing", (provider, model, baseUrl) => {
    const llm = new LLM(cfg(provider, model, baseUrl));
    // aiSdkModel is built (not the codex null path).
    expect((llm as unknown as { aiSdkModel: unknown }).aiSdkModel).not.toBeNull();
  });

  // deepseek/qwen/kimi are not pi-ai KnownProviders; minimax is, but its default
  // model isn't in pi-ai's catalog so it's deliberately excluded from PI_AI_PRICED.
  // Both paths must yield a null pricing model (cost: undefined on the ledger).
  it.each([["deepseek"], ["qwen"], ["kimi"], ["minimax"]])(
    "%s resolves to a null pricingModel",
    (provider) => {
      const llm = new LLM(cfg(provider, "some-model"));
      expect((llm as unknown as { pricingModel: unknown }).pricingModel).toBeNull();
    },
  );
});
