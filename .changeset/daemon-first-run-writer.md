---
"@enduragent/coach": patch
"@enduragent/core": patch
---

User-facing: Enduragent now starts normally on a fresh athlete home and reports useful Reference sync errors.

Reuse the daemon lifecycle's authoritative store writer during refresh windows instead of attempting a nested writer acquisition.
