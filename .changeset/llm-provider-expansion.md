---
"@enduragent/core": minor
"cycling-coach": patch
---

User-facing: Added six new LLM providers to setup — DeepSeek, Qwen, MiniMax, Kimi, Z.AI (GLM), and OpenRouter — each selectable in `setup` with its own model list and an optional base-URL override.

Wires DeepSeek (`@ai-sdk/deepseek`), Qwen (`@ai-sdk/alibaba`), and OpenRouter (`@openrouter/ai-sdk-provider`) through dedicated AI SDK factories, and MiniMax/Kimi/Z.AI through `@ai-sdk/openai-compatible` with provider-default base URLs. Adds an `LLM_BASE_URL` override and `llm.base_url` config field, plus a pi-ai KnownProvider typing guard so the widened provider union compiles (providers absent from the priced catalog report `cost: undefined` on the usage ledger).
