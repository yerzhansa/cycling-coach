---
"@enduragent/core": patch
---

User-facing: Added a per-turn safety cap so a flaky provider connection can never run up a large surprise bill on your API key in a single message.
User-facing: Fixed a bug where retrying after a hiccup could create a duplicate workout on your calendar; the coach now tells you honestly if a change was saved but the reply didn't finish.

A single per-turn budget now caps total model calls and total generate attempts across every error class and the flush and compaction ladders, with a five-minute wall-clock checked only between attempts that never aborts an in-flight call, so a brownout turn stops with a classified budget error instead of spending the athlete's pay-as-you-go budget. The agent also records each committed calendar write within a turn and refuses to silently retry once a write has committed, returning an honest message that a change was saved but the reply failed rather than replaying a non-idempotent create into a duplicate workout.
