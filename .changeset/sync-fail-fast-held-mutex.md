---
"@enduragent/core": patch
---

User-facing: /sync now replies instantly when a sync is already running, instead of appearing to hang.

The interactive /sync path consults the sync mutex and returns the "already running" reply immediately rather than blocking the full acquire timeout; the background scheduler's queue-and-wait behavior is unchanged. The /sync reply also no longer renders a dangling "Refreshed:" line on a no-op cycle — it now says the data was already up to date.
