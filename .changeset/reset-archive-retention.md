---
"@enduragent/core": patch
"cycling-coach": patch
---

User-facing: Archived chat sessions are now kept indefinitely by default — previously only the 20 most recent were kept; a new retention setting lets you opt into age-based cleanup.

Session reset archives were pruned to the newest 20 per chat, silently
deleting the only copy of older conversations before any extraction
substrate exists. The count-based prune is removed; a new
session.resetArchiveRetentionDays config knob (env:
SESSION_RESET_ARCHIVE_RETENTION_DAYS, default 0 = keep forever) provides
opt-in age-based pruning instead. Archive file permissions are unchanged.
