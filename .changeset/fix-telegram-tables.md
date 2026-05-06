---
"cycling-coach": patch
---

Fix markdown tables sent by the bot rendering as literal pipe-separated text in Telegram. Telegram has no table primitive in any parse mode, so the fix has two layers:

- **Steer the source.** `sport-cycling/SOUL.md` now tells the LLM to format workout prescriptions as a structured interval list (one step per line: warmup → main → cooldown) and training plans as a phased list. Workouts are inherently sequential and read better on mobile as `3× 10min Z4 (240–260W) / 5min Z2 between` than as a 4-column grid.
- **Defense in depth.** `markdownToTelegramHtml` now extracts any markdown tables that slip through and renders them as `<pre>` (monospace) blocks with columns padded and cell content HTML-escaped. Wide tables still wrap on phones, but the columns line up.
