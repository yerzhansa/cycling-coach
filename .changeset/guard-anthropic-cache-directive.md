---
"cycling-coach": patch
---

Gate the Anthropic ephemeral cache-control directive behind the anthropic provider in the LLM dispatch chokepoint, so openai/google requests carry the plain system string instead of an Anthropic-only `providerOptions` block. Document `GenerateOpts.cacheKey` as codex-only (the AI-SDK arm never reads it; it is forwarded to the codex bridge as its session id). Adds a guardrail test pinning that non-Anthropic AI-SDK providers carry no `cacheControl`/`providerOptions`.
