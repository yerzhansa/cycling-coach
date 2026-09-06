---
"@enduragent/coach": patch
"@enduragent/desktop-renderer": patch
"@enduragent/desktop": patch
---

Keep last-recorded Training history during temporary storage failures, preserve selected rides unless refreshed history proves they were removed, and fence ride analysis cache invalidation against late results.

User-facing: Training now keeps your last recorded history during temporary refresh problems. Ride review no longer closes or reuses out-of-date analysis when refreshed data cannot prove a ride was removed.
