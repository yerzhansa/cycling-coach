---
"cycling-coach": patch
---

User-facing: The bot now shows a typing indicator while it works on your message, so a long reply no longer looks like it went silent.

Starts a best-effort heartbeat that re-emits Telegram's native "typing" chat action every 4s for the duration of the generation phase in the shared turn skeleton, then stops it in a `finally` around generation (never around delivery). Each pulse is isolated: a rejected or throwing pulse is logged at debug and can never affect the turn or its reply, and the interval is unref'd so a pending pulse cannot hold the process open during shutdown or an `/update` drain.
