---
"@enduragent/core": patch
---

User-facing: A sync hiccup no longer silently blanks your data behind a "fresh" stamp — if a data source errors, the coach keeps the last good snapshot and records the failure instead of overwriting it with empties.

Per-endpoint fetch failures (athlete-profile, wellness) now ride a Result-shaped error channel into the Reference layer's data-fetch gate; the gate's data-fetch precondition hard-fails naming the endpoint, so the failed sync routes through the existing gate-rejection path — the prior cache file is preserved, the freshness stamp is not advanced, and the error state records the failure. The same pass adds a content-hash short-circuit to the sync write loop: a no-op cycle (re-fetched data identical modulo metadata) now skips the cache writes entirely, leaving the files byte-identical instead of re-stamping a fresh timestamp every cycle; the sidecar commit marker still advances each cycle.
