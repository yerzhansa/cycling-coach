---
"@enduragent/core": patch
---

Add the Reference layer's Layer-2 response validator and Layer-3 grounding
prompt rules. `validateRecommendation` parses the `---meta---` block a reply
carries, walks dot-paths into the latest snapshot, and asserts every cited value
exists and matches (±0.01 tolerance for numbers, strict equality for everything
else). `validateAndRetry` orchestrates an optional single regeneration (a hard
one-retry cap) across three modes (off / observe / enforce, default observe).
The Layer-3 data-grounding rules are appended to the system prompt so numeric
claims trace back to the snapshot read this turn. The validator is not yet wired
into the live reply path; that lands with the cutover wave.
