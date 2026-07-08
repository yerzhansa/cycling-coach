---
"@enduragent/core": patch
"cycling-coach": patch
---

User-facing: Saved memory no longer gets corrupted when a note contains markdown section headings.

Demote line-start `## ` headings to `### ` inside the single section-write
choke point so heading-bearing content can no longer fragment the section map,
shadow a real section, or leave orphan fragments across reads and replaces.
Export a 4000-char per-section soft cap that emits one structured warn (never
truncates) when a stamped body exceeds it.
