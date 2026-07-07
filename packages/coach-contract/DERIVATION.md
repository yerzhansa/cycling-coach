# Contract derivation appendix

This file maps every field of the two behavior-bearing contract schemas
(`TurnEvent`, `AthleteState`) and the `CoachEngine` method surface to the
engine source it derives from, so a reviewer can diff the contract
symbol-by-symbol against the engine. Grounding commit:
`3463f8593e91d709d78f3444c76dfc3becc8d023`.

Re-grounding rule: any PR that edits `src/turn-event.ts` or
`src/athlete-state.ts` must update this file's citations in the same diff. A
field with no cited source is a review blocker.

## Table A — TurnEvent variants

| Variant tag | Fields | Source citations |
|---|---|---|
| `turn-start` | `turnId`, `chatId` | `packages/core/src/agent/coach-agent.ts:434-435` (turn bracketing: `turnStart` / `turnId` created inside the per-chat session lock), `packages/core/src/agent/coach-agent.ts:420` (`chatId` param of `chat()`) |
| `tool-start` | `toolName` | `packages/core/src/agent/coach-agent.ts:275-292` (write-tool `execute` wrapper — the only execution-boundary hook at the grounding commit), `packages/core/src/agent/coach-agent.ts:76-84` (the five write tools) |
| `tool-end` | `toolName`, `summary?` | `packages/core/src/agent/coach-agent.ts:275-292` (write-tool `execute` wrapper), `packages/core/src/agent/coach-agent.ts:169-180` (committed-write summaries — the `summary` source), `packages/core/src/agent/coach-agent.ts:76-84` (the five write tools) |
| `step-text` | `text` | `packages/core/src/agent/coach-agent.ts:617` (`result.text`), `packages/core/src/agent/coach-agent.ts:620-626` (step-exhaustion recovered text) |
| `final-text` | `text` | `packages/core/src/agent/coach-agent.ts:681` (success return `effectiveText + persistenceNote`), `packages/core/src/agent/coach-agent.ts:423` (`chat()` resolves `Promise<string>`), `packages/core/src/agent/coach-agent.ts:710` (fallback-copy resolution after a committed write) |
| `error` | `error_class`, `kind`, `athleteMessage`, `overflowAttempts`, `timeoutAttempts`, `rateLimitAttempts`, `duration_ms`, `compactions`, plus `turnId`/`chatId` | `packages/core/src/agent/coach-agent.ts:126-136` (the frozen terminal record; snake_case `error_class` / `duration_ms` preserved verbatim), `packages/core/src/agent/coach-agent.ts:143-151` (`error_class` value set), `packages/core/src/agent/coach-agent.ts:699-709` and `packages/core/src/agent/coach-agent.ts:829-839` (emit sites), `packages/core/src/agent/error-classify.ts:9-14` and `packages/core/src/agent/error-classify.ts:66-110` (`kind` + `athleteMessage`), `packages/core/src/channels/telegram.ts:317-321` (the consuming error path) |
| `text_delta` | `delta` | Reserved; no producer at the grounding commit — `packages/core/src/agent/coach-agent.ts:605` uses a non-streaming generate call. The variant exists so adding a streaming producer later is additive, not a contract break. |

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

Derivation rule: `AthleteState` is derived from the persisted latest-data
model, never from the `/status` chat turn —
`packages/core/src/channels/telegram.ts:385-398` shows `/status` is a model
turn, not a deterministic render.

| Contract field | Source |
|---|---|
| `schemaVersion` | `packages/core/src/reference/schemas/latest.ts:59` (`metadata.schema_version`) |
| `lastUpdated` | `packages/core/src/reference/schemas/latest.ts:60` (`metadata.last_updated`) |
| `freshness` | `packages/core/src/reference/schemas/latest.ts:61` (`metadata.freshness`); windows documented at `packages/core/src/reference/freshness.ts:8-18` |
| `degraded` | `packages/core/src/reference/schemas/error-state.ts:41-45` and `packages/core/src/reference/schemas/error-state.ts:77` (`mitigation`), consumed via `packages/core/src/agent/coach-agent.ts:307` (`block_coaching` is the blocking posture) |
| `lastSynced` | `packages/core/src/agent/coach-agent.ts:315` (`latest?.metadata?.last_updated ?? errorState.ts`) |
| `athleteProfile` | `packages/core/src/reference/schemas/latest.ts:64` (`athlete_profile`) |
| `currentStatus` | `packages/core/src/reference/schemas/latest.ts:65` (`current_status`) |
| `derivedMetrics` | `packages/core/src/reference/schemas/latest.ts:7-53` — verbatim key transcription, same keys, same order, same zod types, `.passthrough()` preserved (two fenced substitutions, see footnote) |
| `derivedMetricsMeta` | `packages/core/src/reference/schemas/latest.ts:67-75` — nested strict-optional shape and member names preserved |
| `recentActivities` | `packages/core/src/reference/schemas/latest.ts:76` (`recent_activities`) |
| `plannedWorkouts` | `packages/core/src/reference/schemas/latest.ts:77` (`planned_workouts`) |
| `wellness` | `packages/core/src/reference/schemas/latest.ts:78` (`wellness_data` — explicitly NOT an array; typed `z.unknown()`) |

Renames (source snake_case → contract camelCase): `metadata.schema_version` →
`schemaVersion`, `metadata.last_updated` → `lastUpdated`,
`athlete_profile` → `athleteProfile`, `current_status` → `currentStatus`,
`derived_metrics` → `derivedMetrics`, `derived_metrics_meta` →
`derivedMetricsMeta`, `recent_activities` → `recentActivities`,
`planned_workouts` → `plannedWorkouts`, `wellness_data` → `wellness`. Keys
INSIDE `derivedMetrics` and `derivedMetricsMeta` are not renamed.

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

| Method | Source |
|---|---|
| `chat` | `packages/core/src/agent/coach-agent.ts:419-423` — param `userMessage` → field `message`; `turn.resolvedCs` erased to `z.unknown()` because this leaf package imports nothing from the workspace |
| `resetSession` | `packages/core/src/agent/coach-agent.ts:852-879` (`{ memoryFlushed: boolean }` result) |
| `hasSession` | `packages/core/src/agent/coach-agent.ts:848-850` — sync boolean lifted to a Promise-returning response for RPC uniformity |
| `getAthleteState` | The Table-B derivation (the persisted latest-data model plus the degrade sources) |

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

| Code | Constant | Meaning |
|---|---|---|
| 0 | `EXIT_SUCCESS` | Success |
| 1 | `EXIT_AGENT_ERROR` | The agent failed while handling the request |
| 2 | `EXIT_USAGE` | Invalid arguments or usage |
| 3 | `EXIT_DAEMON_UNAVAILABLE` | Daemon unreachable or contended |
| 4 | `EXIT_NOT_CONFIGURED` | Installation not configured |
| 5 | `EXIT_VERSION_MISMATCH` | Protocol version mismatch |

Compatibility note: today's shipped binaries use exit 1 for usage errors
(`packages/core/src/run-binary.ts:188-191`) and exit 2 for a non-TTY setup
(`packages/core/src/setup.ts:234`); those behaviors are unchanged. The
constants govern the future CLI/daemon surface and the version handshake
(`PROTOCOL_VERSION` mismatch → `EXIT_VERSION_MISMATCH`).
