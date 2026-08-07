# Contract derivation appendix

This file maps every field of the two behavior-bearing contract schemas
(`TurnEvent`, `AthleteState`) and the `CoachEngine` method surface to the
engine source it derives from, so a reviewer can diff the contract
symbol-by-symbol against the engine. Grounding commit:
`0bd7a25e56a339a50efb1c917483170b64af86f8`.

Re-grounding rule: any PR that edits `src/turn-event.ts` or
`src/athlete-state.ts` must update this file's citations in the same diff. A
field with no cited source is a review blocker.

## Table A — TurnEvent variants

| Variant tag  | Fields                                                                                                                                                    | Source citations                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `turn-start` | `turnId`, `chatId`                                                                                                                                        | `packages/core/src/agent/coach-agent.ts:434-435` (turn bracketing: `turnStart` / `turnId` created inside the per-chat session lock), `packages/core/src/agent/coach-agent.ts:420` (`chatId` param of `chat()`)                                                                                                                                                                                                                                                                                                                                               |
| `tool-start` | `toolName`                                                                                                                                                | `packages/core/src/agent/coach-agent.ts:275-292` (write-tool `execute` wrapper — the only execution-boundary hook at the grounding commit), `packages/core/src/agent/coach-agent.ts:76-84` (the five write tools)                                                                                                                                                                                                                                                                                                                                            |
| `tool-end`   | `toolName`, `summary?`                                                                                                                                    | `packages/core/src/agent/coach-agent.ts:275-292` (write-tool `execute` wrapper), `packages/core/src/agent/coach-agent.ts:169-180` (committed-write summaries — the `summary` source), `packages/core/src/agent/coach-agent.ts:76-84` (the five write tools)                                                                                                                                                                                                                                                                                                  |
| `step-text`  | `text`                                                                                                                                                    | `packages/core/src/agent/coach-agent.ts:617` (`result.text`), `packages/core/src/agent/coach-agent.ts:620-626` (step-exhaustion recovered text)                                                                                                                                                                                                                                                                                                                                                                                                              |
| `final-text` | `text`                                                                                                                                                    | `packages/core/src/agent/coach-agent.ts:681` (success return `effectiveText + persistenceNote`), `packages/core/src/agent/coach-agent.ts:423` (`chat()` resolves `Promise<string>`), `packages/core/src/agent/coach-agent.ts:710` (fallback-copy resolution after a committed write)                                                                                                                                                                                                                                                                         |
| `error`      | `error_class`, `kind`, `athleteMessage`, `overflowAttempts`, `timeoutAttempts`, `rateLimitAttempts`, `duration_ms`, `compactions`, plus `turnId`/`chatId` | `packages/core/src/agent/coach-agent.ts:126-136` (the frozen terminal record; snake_case `error_class` / `duration_ms` preserved verbatim), `packages/core/src/agent/coach-agent.ts:143-151` (`error_class` value set), `packages/core/src/agent/coach-agent.ts:699-709` and `packages/core/src/agent/coach-agent.ts:829-839` (emit sites), `packages/core/src/agent/error-classify.ts:9-14` and `packages/core/src/agent/error-classify.ts:66-110` (`kind` + `athleteMessage`), `packages/core/src/channels/telegram.ts:317-321` (the consuming error path) |
| `text_delta` | `delta`                                                                                                                                                   | Produced by `packages/engine/src/agent/coach-agent.ts:595` from the streaming provider path defined at `packages/engine/src/llm.ts:124-126`; ordered delta/final behavior is pinned by `packages/engine/tests/coach-agent-streaming.test.ts:84-108`.                                                                                                                                                                                                                                                                                                         |

Notes on Table A:

- At the grounding commit only write tools have an execution-boundary hook
  (`packages/core/src/agent/coach-agent.ts:275-292`); read-tool boundaries
  arrive with a later producer change. The `tool-start` / `tool-end` variants
  are defined now so the union is stable.
- No true per-step text producer exists at the grounding commit; `step-text`
  carries zero-or-more semantics.

### Table A footnote — terminal shapes

- Success → `final-text` is the last event (terminal record `ok: true`).
- Throw with no committed writes → `error` is the last event and no final text
  is delivered (terminal record `ok: false`).
- Failure AFTER a committed write → `error` then `final-text` carrying the
  delivered fallback copy, per
  `packages/core/src/agent/coach-agent.ts:686-711` (the tainted-write path
  resolves with the fallback copy after emitting the `ok: false` record).

The union is step-level precisely so a client can replace the timer-based
typing heartbeat (`packages/core/src/channels/telegram.ts:53`,
`packages/core/src/channels/telegram.ts:68-93`,
`packages/core/src/channels/telegram.ts:309-324`) with real progress. Any
richer error diagnostics crossing a future remote boundary go through the
redaction walk (`packages/core/src/logging/serialize-error.ts:25`); the
`error` variant carries only classified strings and counters, never a raw
error object.

## Table B — AthleteState fields

Derivation rule: `AthleteState` is derived from validated persisted application
state, never from the `/status` chat turn. Most fields come from the latest-data
model; `trainingContext.performanceProgress` additionally reads the verified
store-native analytics-curve generation, and `trainingContext.recentRides`
reads the canonical local activity projection —
`packages/core/src/channels/telegram.ts:385-398` shows `/status` is a model
turn, not a deterministic render.

| Contract field       | Source                                                                                                                                                                                                                                                                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`      | `packages/core/src/reference/schemas/latest.ts:59` (`metadata.schema_version`)                                                                                                                                                                                                                                                                       |
| `lastUpdated`        | `packages/core/src/reference/schemas/latest.ts:60` (`metadata.last_updated`)                                                                                                                                                                                                                                                                         |
| `freshness`          | `packages/core/src/reference/schemas/latest.ts:61` (`metadata.freshness`); windows documented at `packages/core/src/reference/freshness.ts:8-18`                                                                                                                                                                                                     |
| `degraded`           | `packages/core/src/reference/schemas/error-state.ts:41-45` and `packages/core/src/reference/schemas/error-state.ts:77` (`mitigation`), consumed via `packages/core/src/agent/coach-agent.ts:307` (`block_coaching` is the blocking posture)                                                                                                          |
| `lastSynced`         | `data/.scheduler.json:last_sync_at`, validated by `SchedulerStateSchema` and `SCHEDULER_SCHEMA_VERSION` in `packages/coach/src/athlete-state-reader.ts`; this commit marker is the exclusive source, and absent, unreadable, malformed, strict-shape-invalid, wrong-version, null, or invalid-instant scheduler state maps to null with no fallback. |
| `athleteProfile`     | `packages/core/src/reference/schemas/latest.ts:64` (`athlete_profile`)                                                                                                                                                                                                                                                                               |
| `currentStatus`      | `packages/core/src/reference/schemas/latest.ts:65` (`current_status`)                                                                                                                                                                                                                                                                                |
| `derivedMetrics`     | `packages/core/src/reference/schemas/latest.ts:7-53` — verbatim key transcription, same keys, same order, same zod types, `.passthrough()` preserved (two fenced substitutions, see footnote)                                                                                                                                                        |
| `derivedMetricsMeta` | `packages/core/src/reference/schemas/latest.ts:67-75` — nested strict-optional shape and member names preserved                                                                                                                                                                                                                                      |
| `recentActivities`   | `packages/core/src/reference/schemas/latest.ts:76` (`recent_activities`)                                                                                                                                                                                                                                                                             |
| `plannedWorkouts`    | `packages/core/src/reference/schemas/latest.ts:77` (`planned_workouts`)                                                                                                                                                                                                                                                                              |
| `wellness`           | `packages/core/src/reference/schemas/latest.ts:78` (`wellness_data` — explicitly NOT an array; typed `z.unknown()`)                                                                                                                                                                                                                                  |
| `trainingContext`    | Deterministic projection in `packages/coach/src/training-context.ts`, assembled by `packages/coach/src/athlete-state-reader.ts` from the parsed latest snapshot, the persisted-anchor resolver, the sanitized Power Progress source, and the bounded canonical recent-rides source.                                                                  |

Renames (source snake_case → contract camelCase): `metadata.schema_version` →
`schemaVersion`, `metadata.last_updated` → `lastUpdated`,
`athlete_profile` → `athleteProfile`, `current_status` → `currentStatus`,
`derived_metrics` → `derivedMetrics`, `derived_metrics_meta` →
`derivedMetricsMeta`, `recent_activities` → `recentActivities`,
`planned_workouts` → `plannedWorkouts`, `wellness_data` → `wellness`. Keys
INSIDE `derivedMetrics` and `derivedMetricsMeta` are not renamed.

`trainingContext` is optional on the wire so older persisted and test states
remain parseable. The production persisted-state reader always supplies it.
An older daemon omission maps to the exported all-unknown fallback; clients do
not infer it from raw state fields. Within a present older `trainingContext`, a
missing `recentRides` field likewise parses as `unknown/not-synced`.

### Table B.1 — trainingContext envelopes

| Envelope or field group    | Persisted source and recipe                                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `performanceProgress`      | `packages/coach/src/power-progress.ts` reads the current analytics-curve generation and its separate refresh-failure marker, verifies all four archived payloads, runs the unchanged power/HR/sustainability metrics, and emits only bounded display DTOs. Raw curves, provider IDs, generation IDs, archive paths, and metric maps never cross this contract. |
| `recentRides`              | `packages/coach/src/recent-rides.ts` scans at most 200 canonical local activities over a bounded 28-day instant window, keeps at most eight non-transition cycling sessions, and removes workout keys, session ordinals, multisport flags, timer values, and all raw/provider data before projection. Empty, absent, and failed reads remain distinct.         |
| `anchorZones.kind`, `asOf` | Resolver result evaluated at whole epoch seconds parsed from `metadata.last_updated`; invalid time or resolver failure yields `unknown/not-synced`, and a missing resolver result yields `unknown/missing-anchor`.                                                                                                                                             |
| `anchorZones.anchor`       | `watts`, `validFrom`, `source`, `confidence`, `ageDays`, `stalenessBand`, and `stale` are copied from `CyclingFtpAnchorResult` without reinterpretation.                                                                                                                                                                                                       |
| `anchorZones.zones`        | Six ordered rows from one `calculateCyclingZones(anchor.watts)` call; `label` becomes `name`, formatted `value` becomes `range`, and an absent overlap marker becomes `false`.                                                                                                                                                                                 |
| `cyclingLoad`              | Valid `recent_activities` rows parsed by `ActivitySchema`, restricted to the cycling sport contract. `value` sums persisted non-negative `icu_training_load`; counts describe retained cycling rows and missing platform values. No usable value yields `unknown/no-platform-load`.                                                                            |
| `plan`                     | Valid `planned_workouts` rows parsed by `PlannedEventSchema`, restricted to `WORKOUT` rows with a canonical cycling `type`, sorted by local start then numeric id and capped at seven. Empty output yields `unknown/no-plan`.                                                                                                                                  |
| `adherence`                | Only persisted `derived_metrics.consistency_index` plus `consistency_details.{planned_days,completed_days,matched_days}`. Zero planned days yields `unknown/no-plan`; malformed or incomplete values yield `unknown/insufficient-data`.                                                                                                                        |
| `wellnessTrend`            | Valid `wellness_data` rows parsed by `WellnessDaySchema`, sorted and capped to the last seven. The three ordered series project `hrv`, `sleepSecs`, and `restingHR`; absent rows and absent readings use their explicit unknown envelopes.                                                                                                                     |

The two reveal fences below remain unchanged and neither fenced value is a
training-context input.

### Table B footnote — the reveal fence

Exactly two keys are fenced, both as `z.never().optional()` so a present key
fails parse:

- `acwr` — `packages/core/src/reference/schemas/latest.ts:9`
- `"capability.dfa_a1_profile"` — `packages/core/src/reference/schemas/latest.ts:45`

The fence implements the athlete-facing reveal policy: raw workload-ratio
values and the running heart-beat-interval profile are not rendered on
surfaces. A producer that forgets to strip a fenced key gets a parse FAILURE,
not a silent leak. Everything else passes through no stricter than its source
(`.passthrough()` admits unknown future metric keys).

## Table C — CoachEngine methods

| Method            | Source                                                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `chat`            | `packages/core/src/agent/coach-agent.ts:419-423` — param `userMessage` → field `message`; `turn.resolvedCs` erased to `z.unknown()` because this leaf package imports nothing from the workspace |
| `resetSession`    | `packages/core/src/agent/coach-agent.ts:852-879` (`{ memoryFlushed: boolean }` result)                                                                                                           |
| `hasSession`      | `packages/core/src/agent/coach-agent.ts:848-850` — sync boolean lifted to a Promise-returning response for RPC uniformity                                                                        |
| `getAthleteState` | The Table-B derivation (the persisted latest-data model plus the degrade sources)                                                                                                                |

Deliberate exclusion: `getMemory`
(`packages/core/src/agent/coach-agent.ts:881-883`) returns a live
non-serializable object consumed only by the composition root
(`packages/core/src/run-binary.ts:350`) and is not part of the surface
contract.

## Section D — projected method catalogue

Enumeration only — NOT part of this package's interface; schemas land with the
surfaces that need them. Only the four methods in Table C exist now; the
catalogue grows against this same seam.

- CLI verbs: `coach` (REPL), `ask`, `state`, `analyze`, `import`, `plan week`,
  `wellness set`, `sync`, `serve`, `daemon install|status|restart`,
  `mcp serve`, transitional `telegram`.
- MCP tools: `get_athlete_state`, `analyze_activity`, `list_activities`,
  `get_activity_streams`, `plan_week`, `log_wellness`,
  `import_activity_files`, `sync_now`, `ask_coach`.

## Section E — exit codes

| Code | Constant                  | Meaning                                     |
| ---- | ------------------------- | ------------------------------------------- |
| 0    | `EXIT_SUCCESS`            | Success                                     |
| 1    | `EXIT_AGENT_ERROR`        | The agent failed while handling the request |
| 2    | `EXIT_USAGE`              | Invalid arguments or usage                  |
| 3    | `EXIT_DAEMON_UNAVAILABLE` | Daemon unreachable or contended             |
| 4    | `EXIT_NOT_CONFIGURED`     | Installation not configured                 |
| 5    | `EXIT_VERSION_MISMATCH`   | Protocol version mismatch                   |

Compatibility note: today's shipped binaries use exit 1 for usage errors
(`packages/core/src/run-binary.ts:188-191`) and exit 2 for a non-TTY setup
(`packages/core/src/setup.ts:234`); those behaviors are unchanged. The
constants govern the future CLI/daemon surface and the version handshake
(`PROTOCOL_VERSION` mismatch → `EXIT_VERSION_MISMATCH`).

## Section F — persisted display units

`getUnitsPreference` and `setUnitsPreference` are strict authenticated methods
in the one registry at the landed `PROTOCOL_VERSION`. They read and write the
existing `athlete.units` and cycling `sport_settings.preferred_units` fields
through the held writer. Read precedence is cycling override, athlete default,
then the schema-compatible metric default. Results contain only the effective
value and source; authored identity and store fields never cross the wire.
