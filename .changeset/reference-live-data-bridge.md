---
"@enduragent/core": patch
---

Wire live intervals.icu data into the Reference sync. The production fetcher now
pulls the athlete profile, a trailing window of activities and wellness, and a
bounded, best-effort set of per-activity HRV/power streams, runs them through the
ADR-0012 rename anti-corruption layer, bridges the result to the metric-compute
input shape (`FetchedReference` → `MetricInput`), and runs the full metric
registry — so `latest.json` carries real `recent_activities` and a computed
`derived_metrics` block instead of empty stubs.

New modules: `fixture-bridge.ts` (pure bundle → `FixtureShape`/`MetricInput`
assembly), `compute-derived-metrics.ts` (registry runner with per-metric failure
isolation), and `fetch-live-bundle.ts` (the abort-aware, bounded live fetch +
rename boundary). The stream loop is capped, cycling-only, and bounded by a
wall-clock sub-budget so a slow account cannot exhaust the sync timeout; a
malformed row or failed stream is skipped with a warning rather than failing the
whole sync. Stream responses are normalized from the API's array-of-channels
(and camelCased keys) into the channel-keyed shape the DFA-α1 block consumes, and
the metric date-window anchor uses naive local time so it lines up with
intervals.icu's local-time activity dates. A hard fetch/assembly failure (or a
surviving trademark-named key) is converted into a failed sync that writes
`error_state.json` for the curator, rather than escaping the sync uncaught.

`derived_metrics` keeps its `z.unknown()` typing and the per-window
power/HR/sustainability curve fetch is not yet wired (those capability metrics
reproduce their null blocks until it lands); both are tracked as follow-ups. The
`history`/`intervals`/`routes`/`ftp_history` retention cache files keep their
stubs. Metric math is untouched — parity stays green (559/559).

Internal sync-plumbing change; no athlete-facing output change yet.
