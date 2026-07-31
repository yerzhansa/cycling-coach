---
"@enduragent/core": patch
---

Adds per-role model routing for the background compaction caller (provider-dependent default lane, LLM_COMPACT_MODEL / llm.compact_model override), restructures compaction calls into a cache-capable system+messages shape with an enlarged pinned instruction block, reserves the sync-triage and dream caller roles, and lands the operator-run compaction quality gate tooling.
