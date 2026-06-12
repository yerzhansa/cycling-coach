---
"@enduragent/core": patch
"@enduragent/sport-cycling": patch
---

Every destructive memory write (section replace, plan overwrite, section
rename) now appends a journal line to memory/MEMORY.history.jsonl before
mutating: {ts, op, section, oldBody, newBody, source}. The journal is
append-only, 0600, best-effort (a journal failure warns and never blocks
the write), and makes silent fact loss reconstructible by replay. Write
paths now declare their source (chat-tool, flush, sport-tool, migration).
