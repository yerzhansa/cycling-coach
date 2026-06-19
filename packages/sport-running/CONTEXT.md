# Sport-Running

Implements the `Sport` contract from `@enduragent/core` for running. This wave ships **critical-speed-anchored pace zones** — the rest of the Sport surface (plan builder, periodization, workout serializer) is deferred.

## Status: alpha — zones vertical only

Private workspace package, not published to npm. Becomes a published `@enduragent/sport-running` (SemVer) when a real consumer needs it. See ADR-0009.

## Pace zones (the shipped surface)

- **Anchor: Critical Speed (CS)**, the asymptote of the speed–duration relationship and the heavy↔severe boundary (maximal metabolic steady state). All band edges are fractions of CS; CS is SI **m/s**.
- **Two cite-grade boundaries only:** the **0.823 × CS** lower / aerobic-threshold (LT1) line (Hunter 2024) and **1.0 × CS** itself (Nixon 2021). The surrounding band edges are coaching convention.
- Lower boundary ships **flat (82.3%)** for every athlete with a manual override clamped to **[0.78, 0.88]** of CS (clamp is disclosed). **No fitness-graded factor, no sex coefficient** — sex is disclosure-only voice (`SOUL.md`).
- `calculateRunningZones(criticalSpeedMps, paceUnits?, lowerFraction?)` is a pure calculator in `src/zones.ts`; the `calculate_zones` tool (`src/tools.ts`) carries per-athlete state in tool input/output (never the shared system prompt) and attaches a real `confidence`/`csSource` field.

## CS source (decision LOCKED 2026-06-17)

Primary = **intervals.icu-supplied** value (`threshold_pace`, stored in SI m/s; `pace_units` is a display preference only). **Manual override** is implemented now and outranks the platform value; it is also the cold-start path. Computing our own CS from a best-efforts curve is **deferred** (rationale in the running pace-anchor research notes, local-only).

## Validation gate

`checkCsSource` lives in **core** (`packages/core/src/reference/validation/checks/step5-cs-source.ts`, registered in `sync-gate.ts` as `step5_cs_source`), not here — core owns sync-time validation gates uniformly, following the step1 FTP-source gate precedent (ADR-0021 §4). It refuses to emit zones when a running row carries no sane CS anchor (manual `critical_speed` > platform `threshold_pace`), resolve-or-skip for non-runners. This is the first live instance of the CS-family gate pattern the swim CSS gate (ADR-0021) will follow.

## Cross-references

- ADR-0010 (reference adapter seam), ADR-0021 (sibling swim CSS gate + the CS/CSS sync-gate pattern), ADR-0004 (tool composition).
