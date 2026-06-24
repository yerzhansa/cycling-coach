---
"@enduragent/core": patch
---

Change the in-process scheduled sync cadence from every 30 minutes to every 6 hours (`SCHEDULED_SYNC_INTERVAL_MS`). The boot sync is unchanged; this only lengthens the recurring in-process refresh timer, reducing intervals.icu API load. Data stays within the 24h "fresh" band between refreshes.
