---
"@enduragent/core": patch
"cycling-coach": patch
---

Adds an append-only event ledger (memory/events.jsonl) recording dated
athlete events — decisions, overrides, illness, experiments, outcomes —
with a closed kind enum and host-stamped timestamps. The memory flush
gains a ledger_append tool and an event-extraction prompt clause so these
events are captured durably instead of being lost at extraction time.
