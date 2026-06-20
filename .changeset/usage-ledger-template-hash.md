---
"@enduragent/core": patch
---

Tag the local usage-ledger turn line with the prompt template hash. The turn line now carries an optional `templateHash` so a recorded latency/timing sample is attributable to the exact prompt revision that produced it, without a timestamp join against the chat-store. The value is already computed at the append site; only the turn line carries it (the per-generation line stays as-is). Additive and optional — existing ledger lines and readers are unaffected.
