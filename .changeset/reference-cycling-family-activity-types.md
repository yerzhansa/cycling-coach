---
"@enduragent/core": patch
"@enduragent/sport-cycling": patch
---

User-facing: Reference now recognizes mountain-bike, gravel, and e-bike rides as cycling activities.

Widened the `IntervalsActivityType` union and the cycling sport's `intervalsActivityTypes` to include `MountainBikeRide`, `GravelRide`, and `EBikeRide`, so these rides route to the cycling adapter and reconcile with the cycling sport-family counts. The per-metric internal cycling gates are unchanged, so efficiency, durability, and consistency continue to treat e-bike rides as out of scope.
