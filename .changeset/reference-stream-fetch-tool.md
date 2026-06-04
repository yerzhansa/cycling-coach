---
"@enduragent/core": patch
---

Add `tools/fetch-streams.ts` — a dev-time fetcher for the per-activity raw streams and per-athlete power/HR/sustainability curve sets used to author the Reference layer's curve- and stream-driven fixtures. Reads the secondary intervals.icu account, caches each raw response under `referenceDataDir("cycling-coach")/streams/`, is idempotent (skip-if-cached), and throttles requests serially. The snapshot harness never reads this cache — it is operator scratch only.

Pure dev-time infra — athletes don't notice.
