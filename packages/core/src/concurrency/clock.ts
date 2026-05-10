// Adapted from CrankAddict/section-11 (MIT, 2026); see NOTICE.md.

/**
 * Injectable clock primitives for horizontal-layer orchestrators (Reference's
 * `runSync` + `Scheduler`, plus future Decision/Heartbeat/Coaching Loop
 * counterparts per ADR-0011's "future horizontal layers copy this pattern").
 *
 * Why a dedicated `Clock` and not just `Date`: tests need to drive the outer
 * timeout deterministically. vitest's fake timers don't intercept
 * `AbortSignal.timeout` cleanly under the parallel pool, so the orchestrator
 * accepts a clock at construction time and tests inject spies/fakes.
 *
 * `Cooldown`'s constructor accepts `now: () => number = Date.now` — that
 * predates this interface and lives in a different idiom (millisecond-based
 * cooldown windows, not Date-based scheduling). Unifying is possible but
 * would force `new Date(clock.now())` at every Date-call site; not worth it.
 */
export interface Clock {
  readonly now: () => Date;
  readonly setTimeout: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}
