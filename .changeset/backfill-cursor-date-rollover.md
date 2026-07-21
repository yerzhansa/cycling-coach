---
"@enduragent/sync-intervals-icu": patch
"cycling-coach": patch
---

User-facing: Training history sync now keeps working across calendar days and picks up newly recorded activities.

Reopen the final full-history window across date rollovers, resume interrupted terminal windows, and resolve the UTC upper bound for every sync while retaining strict cursor range validation.
