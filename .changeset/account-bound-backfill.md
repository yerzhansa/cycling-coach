---
"@enduragent/coach": patch
"@enduragent/kernel": patch
"cycling-coach": patch
---

User-facing: Cycling Coach now refuses to save an intervals.icu key for a different athlete than the training history already stored.

Record one store-level owner fingerprint from the resolved intervals.icu athlete identifier at sync time, compare it read-only before credential saves, allow saves when the comparison is unavailable, and keep credential rotation independent from account ownership.
