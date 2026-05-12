# Reference

Reference is a port of [section-11](https://github.com/CrankAddict/section-11) (CrankAddict, MIT, protocol v11.43). See [`NOTICE.md`](../../../../NOTICE.md) for full attribution and the list of modifications introduced during the port. Per-file boilerplate convention: every file under `packages/core/src/reference/` carries a one-line header comment — `// Adapted from CrankAddict/section-11 (MIT, 2026); see NOTICE.md.` — establishing the credit at the source.

Reference is the **data + sport-aware adapter substrate** that grounds coaching in verified athlete numerics. Without Reference, the agent answered training questions from whatever fragments the LLM remembered + whatever live `intervals_fetch_*` call happened to fire that turn — a fragile composition that drifted across sessions and produced different numbers for the same question depending on what slipped through compaction. Reference replaces that with a curated `latest.json` snapshot injected into every system prompt, plus `reference_read_*` tools for the LLM to ask for derived metrics by name.

Reference lives **inside core** at `packages/core/src/reference/` per the Reference PRD's Decision 4 + ADR-0009 (defer library publishing until a real second consumer exists). The reverse path is mechanical when that consumer materializes — the directory and its sport-adapter contract type move out together.

## Submodule layout

```
reference/
├── CONTEXT.md          (you are here)
├── index.ts            (public barrel — wired into packages/core/src/index.ts)
├── services.ts         (ReferenceServices — service-aggregate exposed to channels per ADR-0010)
├── runtime.ts          (ReferenceRuntime + bootstrapReference — pins ADR-0011 two-phase init)
├── sport-adapter.ts    (the per-sport seam type — ReferenceSportAdapter + DfaSummary + PowerCurveDelta)
├── freshness.ts        (single-source-of-truth constants: freshness, retention, mutex/cooldown timings)
├── paths.ts            (referenceDataDir(binaryName) — composes via getCoachHome)
├── preserve-tokens.ts  (REFERENCE_PRESERVE_TOKENS — Wave 5 / F21 fills; sports spread)
├── schemas/
│   ├── index.ts        (public barrel — re-exports cache-index.ts + inputs.ts)
│   ├── cache-index.ts  (cache-schemas-only barrel for the strict-schemas regression test; not a public-facing surface)
│   ├── inputs.ts       (sport-agnostic forward-looking inputs — Activity, WellnessDay, WeeklyRollup, FtpHistoryPoint, PlannedEvent, IcuIntervalRep, ZoneTimes — consumed by Wave 2 metric computers; z.looseObject() so real intervals.icu shape rides along)
│   ├── latest.ts       (latest.json — curator's authoritative snapshot)
│   ├── history.ts      (history.json — daily / weekly / monthly retention buckets)
│   ├── intervals.ts    (intervals.json — per-rep workout segments)
│   ├── routes.ts       (routes.json — recent route metadata)
│   ├── ftp-history.ts  (ftp_history.json — FTP test + eFTP time series)
│   ├── scheduler.ts    (.scheduler.json — last_sync_at / next_sync_at coordination state)
│   └── error-state.ts  (error_state.json — Layer-1 sync gate failures, curator-visible)
├── sync/               (Wave 1b / F4 — runSync orchestrator, scheduler, /sync command)
├── metrics/            (Wave 2 — load / distribution / capability / compliance metric computers; index.ts barrel scaffolded by F7, populated by F8–F11; re-export discipline doc at metrics/README.md)
├── validation/         (Wave 4 — Layer 1 sync gate, Layer 2 LLM-output validator)
├── curator/            (Wave 5 — latest.json curator + system-prompt injection)
├── units/              (Wave 6 — Quantity, formatQuantity, athlete preference plumbing)
└── audit/              (Wave 7 — audit log writer, size warnings)
```

## Tool naming convention

- **`intervals_fetch_*`** — direct-from-API tools the LLM previously called per turn. Five of these (`_athlete`, `_wellness`, `_activity`, `_activities`, `_list_events`) are **deleted in Wave 5** as Reference takes over the data path. `intervals_fetch_streams` is **retained** as an escape hatch for raw stream inspection (debug, edge cases the curator's projection misses).
- **`reference_read_*`** — Reference-owned tools the LLM calls to load derived metrics by name (`reference_read_history`, `reference_read_intervals`, `reference_read_routes`, etc.). All read from the cache files documented in `schemas/`. Wave 5 / F19.

The two prefixes are how the LLM (and a code reviewer) tells "live API call, may go stale within seconds" from "snapshot read, deterministic between syncs."

## Schema versioning + drift gate

Per the Reference PRD's Decision 9, schema versioning is informational; **Zod-strict-as-gate is the load-bearing mechanism.** Each cache file declares its own `<FILE>_SCHEMA_VERSION` constant in `schemas/`. When a schema's shape changes:

1. Bump the `<FILE>_SCHEMA_VERSION` for that file only — never bump in lockstep with siblings (see `CONTRIBUTING.md` "Reference schema-version policy").
2. Update the schema definition.
3. The next `runSync()` writes data conforming to the new shape.
4. `safeReadJson` rejects any pre-existing cache file via the Zod `.strict()` parse — caller treats it as a cache miss and triggers a fresh sync.

There is no `migrate-v1-to-v2.ts`. The gate handles drift via discard-and-resync.

## Anti-corruption layer (per ADR-0012)

intervals.icu emits seven fields named in TP-trademarked vocabulary. Reference reads them at the I/O boundary and re-emits plain-English equivalents; the source field names never appear on the typed surface. The rename layer at `sync/rename-tp-fields.ts` is the single anti-corruption boundary for this vocabulary — downstream consumers (F8–F11 metric computers, curator projection, channel-side display) consume the renamed fields only.

| API field (raw, intervals.icu) | Plain-English emitted |
|---|---|
| `wellness.ctl` | `fitness` |
| `wellness.atl` | `fatigue` |
| `wellness.ctlLoad` | `fitnessContribution` |
| `wellness.atlLoad` | `fatigueContribution` |
| `wellness.rampRate` | `weeklyFitnessChange` |
| `activity.icu_ctl` | `fitnessAtEnd` |
| `activity.icu_atl` | `fatigueAtEnd` |

Two functions + a defensive walker live in `sync/rename-tp-fields.ts`:

- `renameTpFieldsOnWellnessRow(raw, summary?)` — five wellness renames.
- `renameTpFieldsOnActivity(raw, summary?)` — two activity renames.
- `assertNoTpKeysRemain(value)` — recursive walker that throws if any TP-denylist key survives anywhere in the input (defense-in-depth for the "intervals.icu adds nested TP aggregates" failure mode). The error path uses `[<index>]` array form only — never includes row-id values — so operator log forwarding stays safe.

**F8 wiring obligation.** F8 (Wave 2) activates `sync/fetch-reference-data.ts`. When that wiring lands, fetch-reference-data MUST call the rename layer between the API-response parse and the cache-write step. The rename layer is also wired into the operator fixture CLI (`tools/sanitize-fixture.ts`); both call sites stay in lockstep so the typed surface is consistent across sync paths.

**Naming-collision callout.** intervals.icu's `WellnessRecord` lib type declares a `fatigue` field (subjective 1–5 scale, athlete-reported). Our Banister-derived `fatigue` (renamed from `atl`) has different semantics. The lib's field rides through via the `z.looseObject` index signature; no future feature should consume both under the same name. If a future feature needs the subjective scale, promote it under a different name (e.g., `subjectiveFatigue`).

**Trademark policy.** The single source of truth for the typed-surface field-name policy lives at `trademark-policy.ts` (`TP_API_FIELDS`, `TP_DENYLIST_FIELDS`). The PR-time lint at `tools/check-trademarks.ts` is independent (uppercase string-literal scope). Background, USPTO records, and the Golden Cheetah enforcement precedent: `docs/knowledge/research/trademark-tp-terms.md`.

## Sport seam (per ADR-0010)

Sports plug into Reference via the optional `Sport.referenceAdapters?(): readonly ReferenceSportAdapter[]` method (lands type-only in Wave 1; cycling implementation in Wave 3). Each adapter declares activity types it handles, plus declarative metadata (zone basis, decoupling basis, sustainability anchors, DFA-validated flag) and optional algorithm hooks (`computeDfa`, `computePowerCurve`). Two startup invariants — disjoint coverage + subset coverage of `sport.intervalsActivityTypes` — are enforced by Reference's dispatcher (Wave 3 / F12).

## Channel seam (`services.ts`)

Reference exposes a `ReferenceServices` aggregate to downstream channels (Telegram in Wave 1b; CLI / web later) via `services.ts`. The channel imports the type; Reference does not import from channels. Per ADR-0010, layers own their contracts — and this aggregate IS Reference's. Future waves extend `ReferenceServices` in place rather than per-channel:

- Wave 5 / F19 — adds `maybeRefreshIfStale()` for the curator's lazy-sync trigger.
- Wave 7 — adds operator-facing scheduler controls (`/sync now`, `/scheduler stop`, etc.).

## Relationships

- **Reference → `getCoachHome` (F1)** — every persisted file routes through `referenceDataDir(binaryName)` which composes `getCoachHome`. No Reference module hardcodes `~/.cycling-coach` or `~/.enduragent/cycling`.
- **Reference → `Sport.referenceAdapters?()` (F2)** — type-only seam. Sports without per-sport affordances simply omit the method.
- **Reference → freshness constants** — every Reference window number lives in `freshness.ts`. Imported, never re-declared.
- **Reference → I/O helpers** — every persisted-state read uses `safeReadJson` (now in `core/io/safe-read-json.ts`); every write uses `atomicWriteJson` (now in `core/io/atomic-write-json.ts`). Reference NEVER calls `JSON.parse(readFileSync(...))` or `writeFileSync(path, JSON.stringify(...))` directly.
- **Reference → concurrency primitives** — `AsyncMutex`, `chainedSignal`, `Cooldown` live in `core/concurrency/` (per ADR-0011's "future horizontal layers reuse the shared primitives"). Reference imports them; Decision/Heartbeat/Coaching Loop will too.

## Out of scope (Wave 1)

The placeholder directories `metrics/`, `validation/`, `curator/`, `units/`, `audit/` are reserved for future waves. Each ships its own focused PR with its own per-file section-11 attribution boilerplate.

For the full per-wave plan, see `docs/initiatives/section-11/features/reference/`.
