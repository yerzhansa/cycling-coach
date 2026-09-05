---
"@enduragent/desktop": patch
"cycling-coach": patch
"@enduragent/engine": patch
---

Retain unsummarized conversation history after compaction failures and stop when it cannot safely fit.

User-facing: If a conversation summary fails, the coach keeps the original context or asks you to try again instead of silently forgetting earlier goals and corrections.
