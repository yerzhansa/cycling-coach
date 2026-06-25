---
"@enduragent/core": patch
---

User-facing: The "update available" notification now invites you to tag or DM @yerzhansa on X.com with feedback, feature requests, or bugs.

Appends a one-line feedback call-to-action to the startup update-available broadcast in the Telegram channel. Plain-text only (the broadcast sends without a parse mode), so no markdown/HTML escaping concerns. Broadcast filtering and once-per-version dedupe are unchanged.
