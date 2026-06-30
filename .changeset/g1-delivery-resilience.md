---
"cycling-coach": patch
---

User-facing: Telegram now retries failed message delivery, threads replies to your message, and shows clearer error messages; the CLI no longer prints raw error objects.

Splits generation from delivery in the Telegram turn so a post-generation delivery failure is no longer shown generation copy, installs a bounded API-level retry transformer, adds a process-local resend cache (send "resend" to re-emit the last answer), threads final replies to the inbound message, moves the auth `next()` outside its guarded block so downstream handler errors are no longer mislabeled as security errors, registers a last-resort `bot.catch`, and routes both the Telegram channel and the CLI through one shared error classifier.
