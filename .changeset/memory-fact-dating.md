---
"@enduragent/core": patch
"cycling-coach": patch
---

User-facing: The coach now records when each remembered fact was last confirmed and flags facts older than six months for re-confirmation.

Every memory section write stamps an "_updated: YYYY-MM-DD" first body line
(athlete-timezone date, idempotent restamp), and the memory-extraction prompt
now requires a source and as-of date on durable facts, keeps existing dates
on unchanged facts, and appends "(re-confirm)" to facts older than six months.
