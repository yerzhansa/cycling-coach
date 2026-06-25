---
"cycling-coach": patch
---

User-facing: Refreshed the model picker to the current generation — added Claude Opus 4.8, GPT-5.5, Gemini 3.5/3.1, GLM-5.2, MiniMax M3/M2.7, Kimi K2.6 and Qwen 3.5, and retired stale options.
User-facing: A single server hiccup or network blip from the AI provider no longer ends your turn — the coach now retries briefly and keeps going.
User-facing: A backward or frozen system clock no longer makes stale training data appear fresh.
User-facing: The coach now declines to quote numbers from stale data and tells you so, instead of fabricating from a stale cache.
User-facing: A sync hiccup no longer silently blanks your data behind a "fresh" stamp — if a data source errors, the coach keeps the last good snapshot and records the failure instead of overwriting it with empties.
User-facing: /sync now replies instantly when a sync is already running, instead of appearing to hang.
User-facing: Fixed a bug where a full disk could discard a reply you'd already received — the coach now always shows the reply and tells you once if it couldn't save it to your history.
User-facing: Added a per-turn safety cap so a flaky provider connection can never run up a large surprise bill on your API key in a single message.
User-facing: Fixed a bug where retrying after a hiccup could create a duplicate workout on your calendar; the coach now tells you honestly if a change was saved but the reply didn't finish.
User-facing: The coach no longer silently half-schedules a multi-workout week — it confirms the plan and writes workouts across follow-up turns instead of running out of room mid-write.
User-facing: Repeated identical data lookups within a single message are reused instead of re-fetched, so the coach answers faster and uses less of your API budget.
User-facing: A coaching turn that runs out of steps now tells you what it gathered and to ask it to continue, instead of failing with a generic apology.
User-facing: Deep race-review turns with very large data fetches now degrade gracefully instead of failing.
User-facing: /quit, /exit, and Ctrl-D now exit cleanly, and startup shows a "syncing training data" line (with an explanation if the first sync fails).
User-facing: The bot now answers quick commands like /version while a long /plan is still being generated, and Telegram's "/" menu lists every command.
User-facing: Workout prescriptions and code blocks now render exactly as written, links are clickable, and formatting errors fall back to clean readable text.
User-facing: The coach now mirrors your wording — it explains efforts in plain feel-language unless you used the technical term first, names the signal behind every recommendation, and the cycling zone numbers it prescribes now match the mainstream 7-zone scheme your head unit uses.
User-facing: The "update available" notification now invites you to tag or DM @yerzhansa on X.com with feedback, feature requests, or bugs.

These athlete-facing improvements all shipped in the 2026.6.25 binary, but their release notes were filed against the private `@enduragent/core` package, so the published `cycling-coach` release (the source `/whatsnew` reads) never carried them. This notes-only changeset re-files them under `cycling-coach` so the next release surfaces them. The CI guard added alongside this change prevents the misfiling from recurring.
