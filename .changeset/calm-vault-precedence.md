---
"cycling-coach": patch
---

User-facing: Kept the athlete's chosen ChatGPT or API-key provider active while saved inactive keys stay clearly marked as not in use.

Stored credentials now hydrate only the provider the athlete selected, while explicit provider changes remain authoritative. Only genuine application failures offer a retry, and replay self-heals an unrecorded selection without overriding a different recorded choice.
