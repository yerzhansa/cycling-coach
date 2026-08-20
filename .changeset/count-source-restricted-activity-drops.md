---
"cycling-coach": patch
---

Count the activity rows the intervals.icu sync drops and carry the split on the sync result.

`activityIndex` and the reference-capture derivation now tally every dropped activity row into two buckets: `sourceRestricted` (the row's `source` is exactly `STRAVA`, which the Strava API Agreement forbids intervals.icu from forwarding) and `other` (every remaining drop). Detection is on `source` alone — never on absent fields and never on the undocumented `_note` key. The pull lane carries the per-page split on its checkpoint artifact, `runBackfillPages` sums it across pages without double-counting the terminal replay, and `SyncRpcResult` gains a strict `droppedActivities` sub-object whose `sourceRestricted + other` must equal `total`. The counts reach the desktop renderer's succeeded sync state and the reference sync's `SyncResult`. `PROTOCOL_VERSION` moves to 19: `SyncRpcResultSchema` is `.strict()`, so a new engine sending the new field to an old renderer would fail the parse; the handshake's `z.literal(PROTOCOL_VERSION)` turns that into a clean version-mismatch exit instead. No athlete-facing copy changes.
