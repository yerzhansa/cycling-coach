---
"@enduragent/core": patch
---

Consolidate the pure-UTC `YYYY-MM-DD` date-key arithmetic into one shared
`io/` leaf util. The midnight-UTC parse, the milliseconds-per-day constant,
the epoch-ms-to-key format, the calendar-validity round-trip, and the
inclusive-range convention were hand-inlined across the dated-recall tool and
the daily-notes range reader; they now live in a single internal module so the
two call sites can no longer drift on the inclusivity convention or the
midnight-UTC suffix. Behavior-neutral: every pre-existing test stays green with
no assertion changes.
