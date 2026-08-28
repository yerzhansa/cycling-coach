---
"@enduragent/kernel": patch
"@enduragent/engine": patch
"@enduragent/coach": patch
"@enduragent/desktop": patch
---

User-facing: Workout handoffs from Chat now open the same reviewable Plan Proposal after retries or relaunch, while Draft and Plan-creation requests continue in their exact Plan conversation.

Planning stores the destination artifact and request relation together, preserves date conflicts for review, and keeps delivery retryable when destination intake is temporarily unavailable.
