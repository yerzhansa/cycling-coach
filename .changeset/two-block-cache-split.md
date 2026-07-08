---
"@enduragent/core": patch
---

Split the cached system prompt into a stable prefix block and a volatile athlete-context block with per-block cache breakpoints on breakpoint-capable routes (direct Anthropic; OpenRouter qwen), add a message-level cache breakpoint on the last message, and stamp a schema version on persisted prompt-lineage session lines with back-compat for unversioned lines.
