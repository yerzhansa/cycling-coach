---
"@enduragent/core": patch
"cycling-coach": patch
---

User-facing: Long conversations are now condensed safely — the coach saves durable facts to memory and keeps a local archive of the full transcript before condensing older messages, leaves your history untouched if anything fails along the way, and completeness-checks every condensed summary.

The trim-path compaction now flushes memory before rewriting the session
file and skips the rewrite when the flush fails; every successful trim
archives the pre-rewrite transcript to a .precompact sidecar governed by
the existing opt-in retention knob. Summarization of dropped messages
returns failed chunks to the caller instead of discarding them and throws
on total failure so history is never replaced by an empty summary. The
summary-quality audit is extracted into a shared post-step applied by
both compaction pipelines, with output bounded at generation time and the
audit running after any final truncation.
