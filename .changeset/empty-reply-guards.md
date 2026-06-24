---
"@enduragent/core": patch
---

User-facing: A coaching turn that runs out of steps now tells you what it gathered and to ask it to continue, instead of failing with a generic apology.

When a tool-heavy turn spends its whole step budget without producing a final reply, the agent now reads the model's finish reason and runs one final no-tools completion to summarize what it did and what's left; if that still yields nothing (or fails), it falls back to a static "I ran out of steps" line so the athlete always gets actionable text and is never invited to blindly retry — which would re-run already-committed paid side effects. Two defense-in-depth guards back this up: the session store refuses to persist an empty or whitespace-only assistant message, and the long-message sender skips empty chunks so an empty reply can never reach the chat. The finish-reason reader is a single named predicate that the future overflow-classification work will extend.
