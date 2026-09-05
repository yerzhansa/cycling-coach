# Sport-Running

Implements Engine’s `Sport` contract at `@enduragent/engine/sport` for running. The [public index](./src/index.ts) exports critical-speed pace zones, schemas, workout serialization, sport/tools, and a Reference adapter.

## Status: alpha — zones vertical only

Private workspace package. The heading records the initial zones scope; the implemented surface now includes workout serialization and sport/tool composition. [runningSport](./src/sport.ts) composes memory, intervals.icu, and running tools and supplies the Reference adapter. [Running Coach](../running-coach/CONTEXT.md) consumes it. This source wiring does not establish end-to-end coaching behavior or planning completeness.

`check:package-deps` requires `@enduragent/*` packages to remain private. Publication requires a separate policy decision.

## Pace zones (the shipped surface)

- **Anchor: Critical Speed (CS)**, the asymptote of the speed–duration relationship and the heavy↔severe boundary (maximal metabolic steady state). All band edges are fractions of CS; CS is SI **m/s**.
- **Two cite-grade boundaries only:** the **0.823 × CS** lower / aerobic-threshold (LT1) line (Hunter 2024) and **1.0 × CS** itself (Nixon 2021). The surrounding band edges are coaching convention.
- Lower boundary ships **flat (82.3%)** for every athlete with a manual override clamped to **[0.78, 0.88]** of CS (clamp is disclosed). **No fitness-graded factor, no sex coefficient** — sex is disclosure-only voice (`SOUL.md`).
- `calculateRunningZones(criticalSpeedMps, paceUnits?, lowerFraction?)` is a pure calculator in `src/zones.ts`; the `calculate_zones` tool (`src/tools.ts`) carries per-athlete state in tool input/output (never the shared system prompt) and attaches a real `confidence`/`csSource` field.

## CS source (decision LOCKED 2026-06-17)

Primary = **intervals.icu-supplied** value (`threshold_pace`, stored in SI m/s; `pace_units` is a display preference only). **Manual override** is implemented now and outranks the platform value; it is also the cold-start path. Computing our own CS from a best-efforts curve is **deferred** (rationale in the running pace-anchor research notes, local-only).

## Validation gate

[checkCsSource](../core/src/reference/validation/checks/step5-cs-source.ts) remains in Core and is called by its [sync gate](../core/src/reference/validation/sync-gate.ts) as `step5_cs_source`. It rejects collected CS values outside the sanity range and gives manual `critical_speed` values precedence over platform `threshold_pace`. It returns no failure when no values are collected. The running `calculate_zones` tool separately returns `no_cs_anchor` when no anchor is available.

## Monitoring/analyze copy discipline

ADR-0026 governs athlete-facing copy for running ACWR, pace:HR decoupling, and DFA/aerobic-threshold discussion (carried in the monitoring/review skills, not in metric math). Three framings: running ACWR is surfaced as a qualitative load **trend** only — no ratio value and no sweet-spot/danger bands; running DFA is conceptual-discussion only and `dfaValidated=false` (no surfaced running α1 of any kind — value, crossing, or status); an α1 reading near 1.0 is never the aerobic threshold (the cited literature's aerobic-threshold surrogate is ≈0.75). Each half carries its own evidence-grade banner — the DFA half cite-grade, the ACWR/decoupling half abstract-grade — and the copy carries eight enumerated caveats. Copy-only: it changes no ported metric value.

## Cross-references

- ADR-0010 (reference adapter seam), ADR-0021 (sibling swim CSS gate + the CS/CSS sync-gate pattern), ADR-0004 (tool composition), ADR-0026 (running ACWR/DFA labeling discipline).
