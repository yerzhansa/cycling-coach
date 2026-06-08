# Sport-Cycling

FTP-based zones, power-prescribed workouts, bike equipment, cyclist persona. Ships as `cycling-coach` binary.

## Language

**FTP** (Functional Threshold Power):
The maximum sustainable power output (in watts) over ~1 hour. Anchor for zone calculation; all cycling power targets derive from FTP.
_Avoid_: "Threshold power" (ambiguous with marathon-pace etc.)

**Cycling Profile**:
The `cycling-profile` Memory section storing FTP, max HR, resting HR, W/kg ratio, experience level. Sport-specific physiology only — body data (weight, age) lives in Core's `person` section.

**Zone**:
A power-band derived from FTP. Cycling has 7 zones (Active Recovery, Endurance, Tempo, Sweet Spot, Threshold, VO2max, Anaerobic). Power-based, not HR-based.

**Periodization**:
Multi-week structure (Build / Base / Peak / Taper / Recovery) for plan generation.

**Workout**:
A single training session (cycling discipline) — name, duration, structured intervals with zone targets, descriptive notes.

## Relationships

- Implements the **Sport** contract from `@enduragent/core` (declared `cyclingSport: Sport`).
- Owns Memory sections: `cycling-profile`, `cycling-equipment`, `cycling-history` (all sport-prefixed per ADR-0003).
- Declares `intervalsActivityTypes: ["Ride", "VirtualRide"]` for intervals.icu sync.
- `mustPreserveTokens` is function-form; reads `cycling-profile` to extract current FTP value.
- `tools()` composes four buckets per ADR-0004: `createMemoryTools` + `createPureCoreIntervalsTools` + `createCoreToolsWithSportConfig` + sport-specific `createCyclingTools`.
- Migration: `migrateCyclingLegacySections` (`@enduragent/sport-cycling/migrate`) renames legacy `profile`/`equipment`/`health` sections (one-time, idempotent).

## Reference adapter

- `cyclingReferenceAdapter` (`src/reference/`) implements the `ReferenceSportAdapter` contract from `@enduragent/core` (ADR-0010). Declarative metadata only: `activityTypes` `["Ride", "VirtualRide"]`, `zoneBasis`/`decouplingBasis` `"power"`, `sustainabilityAnchors` `CYCLING_SUSTAINABILITY_ANCHORS` (`[300, 600, 1200, 1800, 3600, 5400, 7200]` seconds), `dfaValidated` `true`.
- `cyclingSport.referenceAdapters()` returns `[cyclingReferenceAdapter]`, a fresh array per call so composing sports (duathlon, per ADR-0002) can spread it without sharing a mutable reference.
- The optional `computeDfa`/`computePowerCurve` projection hooks are omitted here; they delegate to the parity-green capability metrics over live data and land once the activity-stream bridge exists.
- The adapter and `CYCLING_SUSTAINABILITY_ANCHORS` are re-exported from the package's public index so a future composing sport can spread them.
