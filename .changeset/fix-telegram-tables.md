---
"cycling-coach": patch
---

Fix markdown tables sent by the bot rendering as literal pipe-separated text in Telegram. Telegram has no table primitive in any parse mode, so the fix has three layers:

- **Steer the source.** `sport-cycling/SOUL.md` now tells the LLM to format workout prescriptions as a structured interval list (one step per line: warmup → main → cooldown) and training plans as a phased list. Workouts are inherently sequential and read better on mobile as `3× 10min Z4 (240–260W) / 5min Z2 between` than as a 4-column grid.
- **Defense in depth.** `markdownToTelegramHtml` now extracts any markdown tables that slip through and renders them as `<pre>` (monospace) blocks with columns padded and cell content HTML-escaped. Wide tables still wrap on phones, but the columns line up.
- **Chunker safety.** Long messages that exceed the 4096-char Telegram limit are now split with `<pre>` blocks treated as indivisible units. If a `<pre>` block alone exceeds the limit, its rows are split across multiple wrapped `<pre>...</pre>` chunks so Telegram never receives an unclosed tag. Also fixes a pre-existing ordering bug where the inline-code regex ate fence backticks and broke fenced code blocks.
