---
"cycling-coach": patch
---

User-facing: A corrupted or hand-edited plan file no longer breaks the chat — the coach simply continues without the plan summary.

[Engineering: loadPlan now goes through safeReadJson with a loose passthrough schema; plan summary omits missing fields instead of rendering "undefined"; orphan MEMORY.md sections emit a names-only structured warn at startup + post-flush; deprecated Memory.appendMemory deleted (zero callers, never on the interface); appendDailyNote skips exact-duplicate notes.]
