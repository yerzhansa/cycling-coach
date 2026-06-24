---
"@enduragent/core": patch
---

User-facing: The bot now answers quick commands like /version while a long /plan is still being generated, and Telegram's "/" menu lists every command.

Telegram turn handlers (/plan, /workout, /status, /review, and free-form messages) now spawn the LLM turn on a tracked task and return immediately, so grammY's sequential update loop is never blocked by a long turn. Per-chat reply ordering is preserved by the existing per-chat session lock inside the agent's chat path. The session reset now runs under that same lock so a reset can no longer interleave with an in-flight turn for the same chat. The command surface is registered with Telegram via setMyCommands at startup (fire-and-forget, conditional on Reference services for /sync, excluding /snapshot), so the client's "/" auto-complete menu populates.
