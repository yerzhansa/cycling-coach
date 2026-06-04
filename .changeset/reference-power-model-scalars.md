---
"@enduragent/core": patch
---

Port the Reference layer's six power-model scalar passthroughs — `eftp`, `w_prime`, `w_prime_kj`, `p_max`, `power_model_source`, and `vo2max`. These are a single passthrough family: the upstream extracts the live cycling estimates from today's wellness row (the latest row in the 28-day window) via `_extract_power_model_from_wellness`, finding the first `type == "Ride"` sportInfo dict and reading camelCase `eftp`/`wPrime`/`pMax` with Python-`round` semantics (1-decimal eFTP and W'-kJ, integer W' and P-max, all guarded by Python truthiness), plus `vo2max` straight off the row. No computation. New `packages/core/src/reference/metrics/power-model.ts` mirrors the extraction line-by-line and the harness's `athlete`-key gate (absent athlete → the empty-power-model state, every key null); the six compute functions register in the metrics registry. Bit-identical against the committed oracle across all 13 fixtures (curve-equipped populated, the other twelve null). Unit tests cover the populated paths the oracles can't reach — the Ride-selection loop, the truthiness gates, the round boundaries, and the latest-in-window row selection.

Internal Reference-layer + oracle work — athletes don't notice.
