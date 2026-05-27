---
"@enduragent/core": patch
---

User-facing: Training-intensity distribution is now computed in the reference layer — the 7-day zone breakdown, the grey-zone / quality-intensity / easy-time shares, and the Seiler 3-zone time-in-distribution (7-day and 28-day, all-sport and primary-sport) with the Treff polarization index and a polarized / pyramidal / threshold classification.

- Added the distribution metrics to `packages/core/src/reference/metrics/distribution.ts` — line-by-line ports of `_get_activity_zones`, `_aggregate_zones`, `_aggregate_seiler_zones`, `_build_seiler_tid`, `_calculate_polarization_index`, and `_classify_tid` (`sync.py:3683-3993`). Seiler 3-zone intensity model per Seiler 2010 (Int J Sports Physiol Perform 5(3):276-291); polarization index per Treff et al.
- All registered in `tools/check-metric-parity.ts`'s `METRIC_REGISTRY`; bit-identical against the oracle across the realistic-athlete + boundary fixtures (`pnpm check-parity --all` exits 0).
- Bit-identity hardening on the load + distribution metrics:
  - `roundHalfEven` rewritten as an exact dyadic-rational round (matches CPython `round()` on every boundary) and hoisted into one shared `metrics/rounding.ts` imported by both metric modules.
  - `total_time` and `selectPrimarySport` now reproduce the oracle's grouped, Neumaier-compensated summation order instead of a flat accumulator, so a fractional `secs` can't drift a rounding boundary.
  - `icu_zone_times` is constrained to object-form only; the HR-zone reader guards a non-numeric bin so a malformed array can't poison the zone sums.
- Added a differential fuzz-parity harness (`tools/fuzz-parity.ts`) that runs randomized fixtures through both the oracle and the TS registry and fails on any divergence, vacuous run, oracle error, or contract violation.

No deviations registered in `tools/intentional-deviations.yaml` — all faithful transliterations under the metric-porting discipline (literature-or-revert; no architect intuition).
