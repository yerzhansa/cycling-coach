---
"cycling-coach": patch
---

Carry balanced activity visibility summaries from the current intervals.icu reference fetch to sync consumers.

`SyncRpcResult` now reports `overall` and `recent7Days` windows. Each window includes its raw total, visible count, other malformed rows, and sorted per-source restrictions with the `source-restricted` reason. Both windows must balance, and recent counts cannot exceed their overall counterparts. Detection still uses exact `source === "STRAVA"`; the contract supports additional providers without collapsing them into one source. Counts stay in memory, come from the same fetch that supplies training context, and no longer come from historical backfill. Mid-page capture resumes report a page's dropped rows once. `PROTOCOL_VERSION` moves from 18 to 19. No athlete-facing copy changes.
