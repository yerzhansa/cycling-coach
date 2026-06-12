---
"@enduragent/core": patch
---

User-facing: Fixed a bug where a flaky intervals.icu connection while saving a workout could create duplicate workouts on your calendar.

The chat-path client now constructs through the intervals client factory with lib-side retry disabled (`maxAttempts: 1`), mirroring the sync path, so non-idempotent calendar writes are never replayed by the HTTP layer.
