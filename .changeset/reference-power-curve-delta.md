---
"@enduragent/core": patch
---

Port the Reference layer's `capability.power_curve_delta` — the shift in mean-maximal power at five anchor durations (5s, 60s, 300s, 1200s, 3600s) across two adjacent 28-day windows, with a `rotation_index` summarising whether gains are sprint-biased (positive) or endurance-biased (negative).

- Added `computePowerCurveDelta` to `packages/core/src/reference/metrics/capability.ts` — a line-by-line transliteration of `_calculate_power_curve_delta` (sync.py:4297-4439). Curves are matched by the `r.{start}.{end}` id string (never by list index); a missing id is a silent-null branch. Per-anchor `pct_change` rounds via the exact `roundHalfEven` half-to-even helper; the rotation mean uses the compensated `pythonSum` for parity with the oracle's CPython 3.12+ `sum()`.
- The window dates are derived from the snapshot's frozen clock ONLY when the fixture carries `power_curves` (mirroring the upstream's fetch gate), so the 12 fixtures without curves reproduce the dateless null block byte-for-byte while the curve-equipped fixture populates `rotation_index` 5.3 with non-null per-anchor entries.
- Registered `capability.power_curve_delta` in `METRIC_REGISTRY`; the parity matrix asserts bit-identical match across all 13 fixtures. No deviation registered — faithful port. Discipline: `docs/adr/0016-metric-porting-discipline.md`.

Pure derived-metric compute — surfaces as coaching context, no athlete-facing command change.
