---
"@enduragent/core": patch
"cycling-coach": patch
---

User-facing: When the model provider asks the coach to back off, waits are now capped at 2 minutes — a huge provider-requested delay can no longer freeze the chat for hours.

Clamps the header-derived retry wait in the chat retry loop to a named 120 s ceiling at the existing backoff site (the 30 s cap previously bound only the locally computed fallback). The existing rate-limit warn line now reports the provider-requested value when clamping occurs.
