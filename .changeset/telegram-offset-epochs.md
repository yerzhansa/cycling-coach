---
"cycling-coach": patch
---

User-facing: Fixed Telegram messages being ignored after a bot restarts following a week of inactivity.

Persist a timestamped update-ID epoch, upgrade the prior offset schema from its file timestamp, and fail open when persisted deduplication state is not trustworthy.
