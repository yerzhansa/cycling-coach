---
"@enduragent/core": patch
---

Add the Reference layer's Layer-1 sync gate. The previously-stubbed
`gateLatestJson` now runs seven mechanical checks before a snapshot is written —
data-fetch presence, FTP source resolvability, weekly-hours consistency,
value-tolerance bands, 24h freshness, clock-offset drift, and multi-metric
conflict. Checks use resolve-or-skip semantics (an absent signal passes, so the
empty-data path is never bricked; only present-and-invalid values fail). Hard
failures block the write and record error state; soft warnings still write, and
a fully clean sync clears stale error state after the commit marker. Downstream
of the metrics layer — it only reads and checks already-computed values, it does
not recompute any metric.
