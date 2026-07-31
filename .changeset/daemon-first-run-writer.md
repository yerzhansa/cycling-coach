---
"@enduragent/coach": patch
"@enduragent/core": patch
---

Reuse the daemon lifecycle's authoritative store writer during refresh windows instead of attempting a nested writer acquisition, so a fresh athlete home starts normally and Reference sync errors render usefully.
