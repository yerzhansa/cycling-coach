---
"@enduragent/desktop": patch
"cycling-coach": patch
---

User-facing: Fixed Desktop Telegram turning itself back on after the user chose Turn off.

Treat the stored power choice as authoritative across status polling, reconciliation, restart recovery, pairing cancellation, and pairing-lease races while preserving the configured bot and paired primary user for a later explicit Turn on.
