---
"@enduragent/core": patch
"cycling-coach": patch
---

User-facing: Container and Railway deploys can now set `LLM_PROVIDER` plus a generic `LLM_API_KEY` for any API-key LLM provider. Provider-specific env vars such as `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, or `OPENROUTER_API_KEY` still work and take precedence.
