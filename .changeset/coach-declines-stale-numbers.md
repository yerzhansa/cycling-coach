---
"@enduragent/core": patch
---

User-facing: The coach now declines to quote numbers from stale data and tells you so, instead of fabricating from a stale cache.

When the latest sync fails validation, the gate records a block-coaching mitigation and the chat turn degrades to general, qualitative guidance with a one-line disclosure of how long since the data last synced. The validation-failure signal flows through an already-present on-disk mitigation channel (no schema change): a HARD sync-gate rejection stamps the error state, and the turn reads it once at start, failing open if that state file is itself unreadable. The degrade block renders in the volatile prompt tail so prompt caching is preserved.
