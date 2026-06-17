---
"cycling-coach": patch
---

Internal refactor: route the per-generation and per-turn usage-ledger lines through one shared `usageFieldsFromResult` mapper, and assert the AI-SDK `inputTokenDetails` cache-token shape in a single `cacheTokenDetails` helper, instead of copying the field-by-field block and cast across `llm.ts` and `coach-agent.ts`. Behavior-neutral.
