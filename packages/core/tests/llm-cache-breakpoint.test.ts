import { describe, it, expect } from "vitest";
import { cacheBreakpointKey } from "../src/llm.js";

// cacheBreakpointKey decides which providers get an EXPLICIT system-prompt cache
// breakpoint (and under which providerOptions key). The contract under test:
// only direct Anthropic and Qwen-routed-through-OpenRouter get one; every other
// provider — including all other OpenRouter-routed models and direct Qwen —
// caches automatically server-side and must stay on the plain-string path.
describe("cacheBreakpointKey", () => {
  it("direct Anthropic → 'anthropic' (unchanged)", () => {
    expect(cacheBreakpointKey("anthropic", "claude-sonnet-4-6")).toBe("anthropic");
  });

  it("Qwen routed through OpenRouter → 'openrouter'", () => {
    expect(cacheBreakpointKey("openrouter", "qwen/qwen-plus")).toBe("openrouter");
    expect(cacheBreakpointKey("openrouter", "qwen/qwen3-max")).toBe("openrouter");
    expect(cacheBreakpointKey("openrouter", "qwen/qwen-2.5-72b-instruct")).toBe("openrouter");
  });

  it("other OpenRouter-routed models stay untouched (auto-cache)", () => {
    expect(cacheBreakpointKey("openrouter", "deepseek/deepseek-chat")).toBeUndefined();
    expect(cacheBreakpointKey("openrouter", "z-ai/glm-4.6")).toBeUndefined();
    expect(cacheBreakpointKey("openrouter", "moonshotai/kimi-k2")).toBeUndefined();
    expect(cacheBreakpointKey("openrouter", "openai/gpt-5.4")).toBeUndefined();
    expect(cacheBreakpointKey("openrouter", "anthropic/claude-sonnet-4.6")).toBeUndefined();
  });

  it("direct Qwen (via @ai-sdk/alibaba) needs no breakpoint — it auto-caches", () => {
    expect(cacheBreakpointKey("qwen", "qwen-plus")).toBeUndefined();
  });

  it("the other direct providers never get a breakpoint", () => {
    for (const p of ["openai", "google", "deepseek", "minimax", "kimi", "zai", "openai-codex"]) {
      expect(cacheBreakpointKey(p, "some-model")).toBeUndefined();
    }
  });
});
