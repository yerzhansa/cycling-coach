---
"@enduragent/core": patch
---

User-facing: Refreshed the model picker to the current generation — added Claude Opus 4.8, GPT-5.5, Gemini 3.5/3.1, GLM-5.2, MiniMax M3/M2.7, Kimi K2.6 and Qwen 3.5, and retired stale options.

Refreshed the setup-wizard model picklist, the per-provider default models (`setup.ts` + `config.ts`), the context-window table, and the cost price catalog (`cost.ts`) to the current-generation models across every provider. Model IDs, per-million pricing, and context windows were verified against each provider's official pricing/docs pages.
