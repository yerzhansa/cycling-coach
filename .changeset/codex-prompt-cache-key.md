---
"cycling-coach": patch
---

User-facing: On the ChatGPT/Codex subscription, your conversation's static context is now served from the model's prompt cache, easing usage-limit pressure during long chats.

Threads a stable per-chat cache-routing key (sha256 prefix of the chat id, never the raw id) from the chat entry point through the codex bridge into the Responses prompt cache key. The non-codex provider path ignores the field by construction.
