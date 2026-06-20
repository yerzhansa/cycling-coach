---
"@enduragent/core": patch
---

User-facing: Fixed a bug where a full disk could discard a reply you'd already received — the coach now always shows the reply and tells you once if it couldn't save it to your history.

The chat turn now delivers the generated reply even when the session append throws, so a full disk or permission error never discards a reply you already paid for. Both session lines are written as a single atomic append, so a partial half-turn can never land, and a disk-full condition is surfaced to you once per process. The fix lives in Core, so both the CLI and the Telegram channel are fixed without a channel edit — mirroring the audit writer's never-break-the-reply-path discipline.
