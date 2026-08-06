---
"@enduragent/desktop": patch
"@enduragent/desktop-renderer": patch
"cycling-coach": patch
---

User-facing: Telegram setup now explains how to recover when secure token storage or Keychain access is unavailable without changing the current bot.

Preserve closed secure-storage refusal reasons across the Desktop process boundary, refuse unencrypted token storage, and emit stage-and-reason-only local diagnostics without exposing credential details.
