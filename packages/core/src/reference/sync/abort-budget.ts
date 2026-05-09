// Adapted from CrankAddict/section-11 (MIT, 2026); see NOTICE.md.

/**
 * Compose a per-runSync orchestrator signal with a per-request timeout
 * budget. Either source aborting fires the returned signal. Used by the
 * intervals-icu wrapper-fetch to enforce both "the outer 2-min orchestrator
 * timeout cancels every in-flight request" AND "no single request consumes
 * the whole orchestrator budget" per ADR-0011.
 */
export function chainedSignal(opts: { outer: AbortSignal; perRequestMs: number }): AbortSignal {
  return AbortSignal.any([opts.outer, AbortSignal.timeout(opts.perRequestMs)]);
}
