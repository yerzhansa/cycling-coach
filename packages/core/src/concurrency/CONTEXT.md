# Concurrency primitives

Horizontal-layer primitives per [ADR-0011](../../../../docs/adr/0011-async-operation-discipline-for-horizontal-layers.md). Reference (Wave 1b) is the first consumer; Decision Layer, Heartbeat, and Coaching Loop will reuse these unchanged.

```
concurrency/
├── CONTEXT.md      (you are here)
├── mutex.ts        (AsyncMutex — non-reentrant, FIFO waiter queue, per-waiter acquire-timeout, hot-warn telemetry)
├── abort-budget.ts (chainedSignal — composes outer signal with per-request timeout via AbortSignal.any)
└── cooldown.ts     (per-key cooldown tracker; lazy-prune on expiry; clock-skew-clamped)
```

These were originally adapted from [section-11](https://github.com/CrankAddict/section-11) (CrankAddict, MIT) and lived under `reference/sync/` and `reference/io/` in Wave 1b. Promoted to `core/concurrency/` in PR C of the architectural followup sequence so future horizontal layers import from one canonical location instead of reaching across module boundaries into Reference.

## Invariants

- **Non-reentrant** — `AsyncMutex.runExclusive` does not allow recursion. A nested call returns `{ kind: "timeout" }` after the acquire-timeout fires; the 30-second pause is the documented smell that surfaces accidental recursion in code review (per ADR-0011 §1).
- **Per-operation AbortController** — every orchestrator should own one `AbortController`, scoped to a single `runExclusive` body. `chainedSignal` composes the orchestrator signal with `AbortSignal.timeout(perRequestMs)` so a single hung request can't consume the orchestrator's full timeout budget (per ADR-0011 §2).
- **Per-call input validation** — `runExclusive` throws if `acquireTimeoutMs` is non-positive or non-finite, if `hotWarnMs` is negative or non-finite, or if `hotWarnMs >= acquireTimeoutMs` (the warn would never fire). Validation runs each call (not in a constructor) because the timing options vary per caller. Fails loud at the boundary so future layers can't silently misconfigure.
- **Cooldown clock-skew clamp** — `Cooldown.check` clamps elapsed time to non-negative so an NTP backwards-skew can't produce a `retryAfterMs` larger than the configured window.

## Related I/O helpers

`core/io/` houses the filesystem primitives that horizontal layers also share: `atomicWriteJson` (async, JSON-serialized), `atomicWriteFileSync` (sync, UTF-8 string — used by `MemoryStore`), and `safeReadJson<T>(path, schema)` (Zod-strict-as-gate per Reference PRD Decision 9). They live in `io/` rather than here because they're general filesystem primitives, not concurrency primitives.
