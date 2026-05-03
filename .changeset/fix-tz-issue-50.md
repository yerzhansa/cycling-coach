---
"cycling-coach": patch
---

Fix dates near local midnight in any non-UTC timezone (closes #50).

The system prompt now carries the IANA timezone name (cache-stable) and a fresh `Current time:` line is appended to each user message. Five "today" call-sites — system prompt, daily-notes filename, intervals_delete_workout past-workout guard, race countdown, daily session-reset hour — now share one resolved athlete TZ instead of computing UTC independently. Resolution chain: `COACH_TZ` env > `session.timezone` (config.yaml) > host TZ (warning) > `"UTC"` (loud warning).
