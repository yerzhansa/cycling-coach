---
"@enduragent/core": patch
---

User-facing: A backward or frozen system clock no longer makes stale training data appear fresh.

The freshness band now treats a cache timestamp more than five minutes in the future as stale (raising a freshness warning) instead of fresh, and the `/sync` reply words a future timestamp honestly instead of clamping it to "0s ago".
