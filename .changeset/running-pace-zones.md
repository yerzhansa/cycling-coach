---
"@enduragent/sport-running": minor
"@enduragent/core": patch
"running-coach": patch
---

Land critical-speed-anchored running pace zones and make them reachable through the running-coach binary.

`@enduragent/sport-running` now ships the `calculate_zones` tool (six CS-anchored pace zones), the running soul + skills, the athlete-profile schema, and a pace-based reference adapter. `@enduragent/core` gains a hard CS-source sync gate (step 5) that refuses to sync a running zone table from a missing or out-of-band critical-speed anchor, plus the `threshold_pace`/`critical_speed`/`cs_source`/`cs_confidence` fields on the sport-settings schema. The `running-coach` binary, previously a stub, now wraps the running sport via Core's `runBinary` — it runs from the workspace (externalized, still private/unpublished).
