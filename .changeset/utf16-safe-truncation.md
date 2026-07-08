---
"@enduragent/core": patch
"cycling-coach": patch
---

User-facing: Fixed a rare bug where an emoji sitting exactly at a length limit could be sliced in half, producing garbled text in long Telegram code blocks, compaction summaries, and memory query results.

All fixed-length string cuts now route through a shared `truncateUtf16Safe` helper that backs the cut off by one UTF-16 unit when it would bisect a surrogate pair. Fixed sites: `splitPreBlock`'s oversized-row fallback and `hardSplit`'s pathological fallback in the Telegram chunker, `capSummary` in compaction, and the `memory_query` result cap. (docs/issues #171)
