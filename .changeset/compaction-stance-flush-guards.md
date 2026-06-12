---
"@enduragent/core": patch
"cycling-coach": patch
---

User-facing: The coach now carries its current training recommendation (and any pushback you've raised) across long conversations instead of sometimes losing it when older messages are condensed.

User-facing: Session resets no longer get stuck when saving memory fails — the coach archives the conversation and starts fresh anyway.

Compaction summaries gain a required Coach Stance section (enforced by the
headings audit) and the MUST-PRESERVE block gains stance, dispute, illness,
and agreed-action bullets, so the summarizer can no longer file the coach's
own recommendation under omittable generic advice. Both reset-path memory
flushes are now wrapped in warn-and-proceed guards so a flush failure cannot
block the session archive.
