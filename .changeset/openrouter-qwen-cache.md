---
"@enduragent/core": patch
---

Enable prompt caching for Qwen models routed through OpenRouter.

OpenRouter does not cache Qwen/Alibaba-backed models unless an explicit cache_control breakpoint is sent — unlike its other routed models (OpenAI/DeepSeek/Grok/Gemini/Moonshot) and the five direct providers, which all cache the stable system prefix automatically. The dispatch path now emits the breakpoint under the `openrouter` providerOptions key for `qwen/`-namespaced models only; every other provider and OpenRouter-routed model is unchanged. The Anthropic branch is generalized into a small `cacheBreakpointKey` resolver (same breakpoint shape, only the key differs).
