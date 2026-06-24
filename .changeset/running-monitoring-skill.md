---
"@enduragent/sport-running": patch
---

Add the running training-monitoring skill that governs how the coach discusses a runner's load trend, pace:HR decoupling, and DFA-α1 / aerobic-threshold material.

`@enduragent/sport-running` now ships a `monitoring` skill (loaded as `running-monitoring`) plus a SOUL guardrail encoding the labeling discipline recorded in ADR-0026: running load is surfaced as a qualitative trend rather than an acute:chronic ratio value or sweet-spot/danger bands; no running DFA-α1 number of any kind is surfaced (conceptual discussion only, `dfaValidated=false`); an α1 reading near 1.0 is never presented as the aerobic threshold (the literature surrogate is ≈0.75); pace:HR decoupling is framed as a flat-terrain, pace-only read; and each evidence half carries its own grade banner alongside eight enumerated caveats. Copy and labeling only — no metric math changes.
