---
"cycling-coach": patch
"@enduragent/desktop-renderer": patch
---

User-facing: Telegram settings now replace expired pairing instructions with the bot's current pairing state.

Reconcile action feedback against semantic bot, power, channel, and pairing state so successful instructions cannot outlive the state that produced them, while preserving warnings and errors across health polls.
