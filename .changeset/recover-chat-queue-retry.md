---
"@enduragent/engine": patch
"@enduragent/coach": patch
"@enduragent/desktop-renderer": patch
"@enduragent/desktop": patch
---

User-facing: Stopping a Chat response or losing connection now keeps the interrupted message retryable and sends later queued messages once, in order.
