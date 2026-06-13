---
"@enduragent/core": patch
"cycling-coach": patch
---

User-facing: If the coach can't fully reset your previous session, it now says so ("some earlier context may still apply") instead of failing silently.

Memory flushes now return a structured outcome ({writes, ledgerAppends,
finishReason, usage, shrunkSections}) instead of discarding the model
result. A flush that writes nothing on a non-trivial conversation, or
that shrinks a memory section by more than 30%, emits a structured warn
event (char counts only — never section content). The flush trigger
paths gain bounded retry and a degradation policy that defers the
session archive when extraction visibly failed.
