---
"@enduragent/core": patch
"cycling-coach": patch
---

User-facing: The coach now saves important details to long-term memory proactively as a long conversation approaches its condensing point, instead of waiting until older messages are about to be dropped.

When the loaded history exceeds 80% of its token budget and at least five
messages have arrived since the last proactive save, the agent runs a
memory flush before building the turn, so facts reach durable memory while
the full raw history still exists. A per-chat in-memory cooldown prevents
repeated flushes; trim-time flushes count toward it and session resets
clear it. A flush failure warns and never blocks the turn.
