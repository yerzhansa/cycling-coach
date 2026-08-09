---
"@enduragent/desktop": patch
"@enduragent/desktop-renderer": patch
---

Setup now stays in Chat until the coach is ready and remains available at the top of Settings for credential and training-data recovery.

Desktop setup readiness is rechecked from durable runtime state on every launch, and chat actions fail closed until the provider, training data, and saved safety intake are ready.
