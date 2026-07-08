---
"cycling-coach": patch
---

User-facing: Messages you send while the bot is offline are no longer dropped when it restarts, and when a new daily session starts the bot now tells you your earlier conversation is archived and your key details are still remembered.

Normal startup no longer drops pending updates; a durable, owner-only offset store (keyed by a short token fingerprint, never the raw token) dedupes anything a previous run already handled and stops `/update` from re-triggering itself after a self-update restart. Operator-capture startup still intentionally drops prior updates. A daily session reset is deferred for one turn when the last exchange is still recent (within 30 minutes), so a conversation that crosses the daily boundary isn't archived mid-thread; malformed timestamps and idle resets are never deferred. On an automatic reset the first reply is prefixed once with a plain-language notice and the model sees a one-turn archive marker so it discloses the fresh session. The athlete's message is now made durable before generation and a failed turn is recorded with a terminal marker, so a mid-turn crash no longer silently erases the message. Compaction now preserves surviving messages' original timestamps.
