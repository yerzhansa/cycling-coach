---
"@enduragent/core": patch
---

Rename the Reference layer's thin per-sport projection type `PowerCurveDelta` to `PowerCurveDeltaSummary` on the `ReferenceSportAdapter` seam. This is a type-only rename with zero behavior change; it disambiguates the thin public projection shape returned by `computePowerCurve` from the rich internal compute type of the same name, so a single projection module can import both without a name collision.
