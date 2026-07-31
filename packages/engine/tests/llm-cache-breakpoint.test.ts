import { describe, it, expect } from "vitest";
import { cacheBreakpointKey } from "../src/llm.js";

// Only direct Anthropic and Qwen-routed-through-OpenRouter get an explicit
// system-prompt cache breakpoint (under that providerOptions key); every other
// provider — all other OpenRouter routes and direct Qwen included — caches
// automatically server-side and must stay on the plain-string path.
describe("cacheBreakpointKey", () => {
  const cases: Array<[string, string, "anthropic" | "openrouter" | undefined]> = [
    // direct Anthropic — the original, unchanged case
    ["anthropic", "claude-sonnet-4-6", "anthropic"],
    // Qwen routed through OpenRouter — the case this resolver adds
    ["openrouter", "qwen/qwen-plus", "openrouter"],
    ["openrouter", "qwen/qwen3-max", "openrouter"],
    ["openrouter", "qwen/qwen-2.5-72b-instruct", "openrouter"],
    // other OpenRouter routes stay untouched (auto-cache, or out of scope)
    ["openrouter", "deepseek/deepseek-chat", undefined],
    ["openrouter", "z-ai/glm-4.6", undefined],
    ["openrouter", "moonshotai/kimi-k2", undefined],
    ["openrouter", "openai/gpt-5.4", undefined],
    ["openrouter", "anthropic/claude-sonnet-4.6", undefined],
    // direct Qwen (via @ai-sdk/alibaba) auto-caches — no breakpoint
    ["qwen", "qwen-plus", undefined],
    // every other direct provider never gets a breakpoint
    ["openai", "some-model", undefined],
    ["google", "some-model", undefined],
    ["deepseek", "some-model", undefined],
    ["minimax", "some-model", undefined],
    ["kimi", "some-model", undefined],
    ["zai", "some-model", undefined],
    ["openai-codex", "some-model", undefined],
  ];

  it.each(cases)("%s + %s → %s", (provider, model, expected) => {
    expect(cacheBreakpointKey(provider, model)).toBe(expected);
  });
});
