---
"@enduragent/kernel-node": patch
"@enduragent/coach": patch
---

Attribute coach store writer failures precisely: recognize write-lock contention across bundle copies by error name, and carry the underlying failure cause through the writer result onto the thrown error.
