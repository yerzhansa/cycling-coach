---
"@enduragent/core": patch
---

Add a literature-grounded aerobic-threshold field to the DFA-α1 capability
profile, alongside the faithfully-ported crossings. Each session now carries an
`aet_crossing` band centered at α1 = 0.75 ± 0.05 — the value the literature
operationalizes as the aerobic threshold (AeT / LT1) — aggregated per sport into
`trailing_by_sport.<family>.aet_estimate` (same indoor/outdoor-split / pooled
shape as `lt1_estimate`) plus `aet_crossing_sessions`. The existing 1.0-centered
`lt1_crossing` (the well-correlated baseline) and 0.5 `lt2_crossing` are
unchanged; `aet` is purely additive.

This is an additive, cite-backed deviation from the upstream oracle (which emits
no 0.75 crossing), registered in `tools/intentional-deviations.yaml` as
`approved-cite`. The parity gate gains an `added_paths` mechanism: for an
approved-cite entry it strips exactly the declared additive paths from the
implementation output before the bit-identity assertion, so every ported value
still asserts bit-identical against the oracle while the additive field rides
alongside (verified by unit tests instead). Cite-content enforcement now runs
locally (where the research tree is checked out) and skips gracefully when it is
not, rather than failing.

Internal plumbing change: `aet_estimate` now appears in `derived_metrics`, but
nothing surfaces it to athletes yet (the everyday-ride reveal and the
1.0-crossing labeling fix remain follow-ups). No athlete-facing output change.
