---
"cycling-coach": patch
---

User-facing: Coach replies now get a bounded model-call deadline and one safe retry for plain timeouts instead of hanging indefinitely.

Bound owned LLM calls with an abort deadline and guard timeout retries from replaying committed tool writes.
