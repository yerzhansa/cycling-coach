---
"@enduragent/core": patch
"cycling-coach": patch
---

User-facing: Condensing a long conversation can no longer hang or fail your message — summarization now times out after two minutes and the coach continues with the best summary it has.

Every staged-summarization LLM call now runs under a 120 s race-only
deadline (classified as a timeout by the existing error classifier).
summarizeInStages degrades instead of throwing: a failed chunk falls back
to the carried summary, and with no summary at all it head-drops the
oldest messages so the turn can proceed. The overflow/timeout rescue
paths rethrow the ORIGINAL turn error with any rescue failure attached
as its cause, so summarization failures can no longer mask the error
that actually ended the turn.
