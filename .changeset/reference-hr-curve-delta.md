---
"@enduragent/core": patch
---

Port the Reference layer's `capability.hr_curve_delta` — the shift in max sustained heart rate at four anchor durations (60s, 300s, 1200s, 3600s) across two adjacent 28-day windows, with a `rotation_index` summarising whether the shift is intensity-biased (positive) or endurance-biased (negative).

- Added `computeHrCurveDelta` to `packages/core/src/reference/metrics/capability.ts` — a line-by-line transliteration of `_calculate_hr_curve_delta` (sync.py:4441-4586). There is no 5s anchor (peak HR at 5s is just max HR, not an energy-system signal) and no sport filter (HR is cross-sport physiological). HR curve entries carry the `values` key (bpm) where power curves carry `watts`. Curves are matched by the `r.{start}.{end}` id string; a missing id is a silent-null branch. Per-anchor `pct_change` rounds via the exact `roundHalfEven` half-to-even helper; the rotation mean uses the compensated `pythonSum` for parity with the oracle's CPython 3.12+ `sum()`.
- The delta reuses `power_curve_dates` (the call site at sync.py:3210 passes the power tuple), so the window dates are gated on the harness having fetched `power_curves` — HR curves without power dates reproduce the dateless null block byte-for-byte. The 12 fixtures without curves keep the null shape while the curve-equipped fixture populates `rotation_index` -3.3 with non-null per-anchor entries.
- Registered `capability.hr_curve_delta` in `METRIC_REGISTRY`; the parity matrix asserts bit-identical match across all 13 fixtures. No deviation registered — faithful port. Discipline: ADR-0016 (metric porting, local design record).

Pure derived-metric compute — surfaces as coaching context, no athlete-facing command change.
