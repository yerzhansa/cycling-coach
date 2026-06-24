---
"@enduragent/core": patch
---

Add a sport-agnostic pace formatter that renders an SI speed (metres per second) to an athlete-facing M:SS pace, keyed on the `pace_units` display preference (per-mile for `MINS_MILE`, per-kilometre otherwise). Distance is parameterised so a per-100 pace can reuse it. Additive presentation helper with no caller yet.
