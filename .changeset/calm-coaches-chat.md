---
"@enduragent/desktop": patch
"@enduragent/desktop-renderer": patch
"cycling-coach": patch
---

User-facing: Added optional Telegram bot setup directly to the desktop Chat setup screen.
User-facing: Moved required desktop setup into Chat and kept it available in Settings for recovery.

Setup now stays in Chat until the coach is ready and remains available at the top of Settings for credential and training-data recovery.

Desktop setup readiness is rechecked from durable runtime state on every launch, and chat actions fail closed until the provider, training data, and saved safety intake are ready.

Chat setup can verify or replace a Telegram bot from a copied BotFather token, remove its local credential safely, and always keeps pairing and access management in Settings.
