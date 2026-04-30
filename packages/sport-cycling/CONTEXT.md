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
