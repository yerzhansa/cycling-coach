---
"cycling-coach": patch
---

User-facing: The bot no longer greets you with the "Welcome to Cycling Coach!" message after a redeploy or `/update`. Existing chats with an on-disk session are recognized as returning.

The previous "have I greeted this chat yet?" tracking was an in-memory `Set` (`packages/core/src/channels/telegram.ts`), wiped on every process restart — so every existing user was treated as a newcomer on their first message after a Railway deploy or self-update. The fix consults the persisted session file in `~/.cycling-coach/sessions/telegram:<chatId>.jsonl` as a durable signal for "returning user" before showing the welcome.
