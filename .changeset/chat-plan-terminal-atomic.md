---
"@enduragent/kernel": patch
"@enduragent/engine": patch
"@enduragent/coach": patch
"@enduragent/desktop": patch
---

User-facing: Applying or rejecting a Chat-originated Plan Proposal now records the matching Chat result atomically, so relaunch cannot show a stale or contradictory handoff.

Planning keeps revised Proposals attached to their originating request, rolls back the complete Plan change when terminal-result storage fails, and leaves calendar mirroring separate from local success.
