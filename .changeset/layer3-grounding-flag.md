---
"cycling-coach": patch
---

User-facing: The coach no longer claims it lacks your latest numbers when it has just fetched them — a premature data-grounding rule is held back until the underlying snapshot read is wired in.

The Layer-3 data-grounding rule was pushed into every prompt before any tool surfaced the snapshot it names, so it is now gated behind a default-off module constant that the cutover flips on once the read tool lands; the ported prose is byte-unchanged and a test pins both flag states. Each assistant session line now also carries a template hash over the static prompt ingredients, an assembled hash over the full built prompt that turn, and the resolved provider and model, so a past reply maps back to its prompt revision; older sessions without the fields still load and everything stays local with zero telemetry.
