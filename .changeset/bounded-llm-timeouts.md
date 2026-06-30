---
"cycling-coach": patch
---

User-facing: Coach replies now get a bounded model-call deadline and one safe retry for plain timeouts instead of hanging indefinitely.
User-facing: Training plans are no longer at risk of being duplicated when a request times out or context overflows.
User-facing: Long chat turns are now bounded so they can't run roughly twice the intended time.

Bound owned LLM calls with an abort deadline and guard timeout retries from replaying committed tool writes.

When a turn has already committed a memory or plan write and then fails (overflow/timeout), it now returns the canned "couldn't finish" message instead of self-healing via replay — deliberately preventing a re-run of the non-idempotent write. The committed write is preserved; only the in-turn answer is sacrificed.
