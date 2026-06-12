---
"@enduragent/core": patch
"cycling-coach": patch
---

User-facing: The coach can now look back through past daily notes and logged events by date — ask "what did we note in March?" and it retrieves the actual record instead of forgetting everything older than today.

Adds a memory_query tool ({from, to, query?}) doing an index-free, case-insensitive
substring scan over dated daily-note files plus the append-only event ledger, and a
static recall-before-answering system-prompt rule. Tool definition and prompt rule
are cache-stable (no per-turn variance).
