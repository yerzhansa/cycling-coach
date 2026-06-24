---
"@enduragent/core": patch
---

User-facing: Deep race-review turns with very large data fetches now degrade gracefully instead of failing.

A generic per-result token-share cap is applied at the tool-registration boundary: any tool whose serialized result exceeds half the context window is replaced with a count-preserving notice the model can act on (rerun with narrower arguments), while small results pass through byte-identical. On top of that backstop, the intervals.icu stream fetch now downsamples raw time-series to 10-second bins with a per-channel min/max/mean stats header that preserves true peaks, so a 3-hour ride fits the smallest supported context window instead of overflowing the mid-turn step loop and exhausting the overflow-recovery retries. Every intervals.icu fetch tool's error path now returns a typed object carrying the error kind plus optional HTTP status or message, additively, without changing the kind key the prompt's error-translation table reads.
