---
"@enduragent/core": patch
---

Enable prompt caching for Qwen models routed through OpenRouter.

OpenRouter auto-caches its OpenAI/DeepSeek/Grok/Moonshot routes but requires an explicit cache_control breakpoint for Anthropic-, Qwen/Alibaba-, and Gemini-backed routes; the five direct providers all cache the stable system prefix automatically. The dispatch path now emits the breakpoint under the `openrouter` providerOptions key for `qwen/`-namespaced models only — `anthropic/` and `google/` routes via OpenRouter remain uncached by design and can be added later. Every other provider and OpenRouter-routed model is unchanged. The Anthropic branch is generalized into a small `cacheBreakpointKey` resolver (same breakpoint shape, only the key differs).
