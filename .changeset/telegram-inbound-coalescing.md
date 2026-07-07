---
"cycling-coach": patch
---

User-facing: Rapid messages sent within about 1.5 seconds of each other are now combined into a single reply, so a thought split across several messages gets one coherent answer instead of several partial ones.

Buffers free-form Telegram text per chat behind a 1.5s debounce window (each fragment resets the window) and joins fragments with newlines into one turn. A slash command flushes the chat's pending text first, then runs immediately, so commands are never coalesced into free-form text. Turn dependencies are resolved at flush time, the flushed turn threads to the last fragment's message id, each fragment fires one best-effort typing action during the window, and shutdown/update drains flush pending buffers synchronously without waiting on the debounce timer. Debounce timers are unref'd so a pending buffer never holds the process open.
