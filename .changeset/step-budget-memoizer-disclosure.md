---
"@enduragent/core": patch
---

User-facing: The coach no longer silently half-schedules a multi-workout week — it confirms the plan and writes workouts across follow-up turns instead of running out of room mid-write.
User-facing: Repeated identical data lookups within a single message are reused instead of re-fetched, so the coach answers faster and uses less of your API budget.

Adds a per-turn read memoizer that wraps read-only tools and reuses an identical same-turn read (keyed on a stable hash of the tool name and its arguments) instead of re-invoking the tool's execute, so a duplicate lookup no longer burns an agentic step or re-pays the athlete's API spend. The memoizer applies ONLY to an explicit, hand-audited read-only allowlist that deliberately excludes the plan-skeleton tool and the calendar/memory writers (a memoized hit would skip their side effects). The cache is per-turn: it is cleared at the top of each chat turn, so an identical read on a later turn re-fetches. A new static rule block discloses the per-turn tool-call budget and prescribes the multi-workout follow-up protocol, riding the cached prompt prefix.
