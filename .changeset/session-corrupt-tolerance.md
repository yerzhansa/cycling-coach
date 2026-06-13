---
"@enduragent/core": patch
"cycling-coach": patch
---

User-facing: A damaged conversation file no longer blocks the chat — unreadable lines are set aside and the rest of your conversation loads normally.

User-facing: /start now tells you when a session reset fails instead of replying with the usual welcome as if it had succeeded.

The session JSONL loader tolerates torn or malformed lines: invalid lines
are quarantined verbatim to a timestamped .corrupt sidecar next to the
session file, the session file is rewritten with only the valid lines, and
loading never throws on corruption. The pre-reset session read is now
best-effort (warn and archive anyway), so the reset path can no longer be
gated behind a successful read of the state it exists to discard.
