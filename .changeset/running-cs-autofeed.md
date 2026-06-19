---
"@enduragent/core": minor
"@enduragent/sport-running": minor
"running-coach": patch
---

Auto-resolve the running critical-speed anchor from synced intervals.icu data so `calculate_zones` no longer depends on the LLM supplying it.

Core gains `resolveRunningCs(latest)` (sharing one row-walk with the step-5 CS-source gate so the two cannot drift) and a per-turn `CoreDeps.resolvedCs` getter; the Telegram channel resolves the anchor from the latest synced profile each turn and passes it into `chat()`. The running `calculate_zones` tool makes `criticalSpeedMps` optional — it falls back to the synced anchor (manual `critical_speed` outranking platform `threshold_pace`), reports real provenance (`csSource` / `anchorOrigin` / `platformConfidence`), and returns a `no_cs_anchor` error rather than guessing when neither is present. The per-turn value is read lazily through a closure, so the prompt-template hash and cache prefix stay stable; non-running sports and the CLI path are unaffected.
