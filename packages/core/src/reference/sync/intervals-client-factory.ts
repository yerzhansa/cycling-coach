import { IntervalsClient } from "intervals-icu-api";
import { chainedSignal } from "../../concurrency/abort-budget.js";

/**
 * Construct a fetch wrapper that injects a chained `AbortSignal` (orchestrator
 * signal + per-request timeout) into every request's `init`. Per ADR-0011:
 * one hung endpoint never consumes the orchestrator's full timeout budget.
 *
 * Exported separately from `makeAbortableClient` so tests can verify the
 * wrapper's signal-threading without spinning up a real `IntervalsClient`.
 */
export function wrapFetchWithSignal(opts: {
  baseFetch: typeof globalThis.fetch;
  outer: AbortSignal;
  perRequestMs: number;
}): typeof globalThis.fetch {
  return (input, init) =>
    opts.baseFetch(input, {
      ...init,
      signal: chainedSignal({ outer: opts.outer, perRequestMs: opts.perRequestMs }),
    });
}

/**
 * Per-`runSync` IntervalsClient. Wraps `globalThis.fetch` with the abortable
 * shim above, and disables lib-side retry (`maxAttempts: 1`) so an
 * outer-timeout abort propagates into `AbortError` without the lib silently
 * recovering. Reference's own retry-after / rate-limit handling lives at the
 * orchestrator layer (per ADR-0011), not at the client layer.
 *
 * `intervals-icu-api@0.1.2` does not expose `signal?: AbortSignal` on its
 * resource methods; the constructor's `fetch` option is the only injection
 * point.
 */
export function makeAbortableClient(opts: {
  apiKey: string;
  athleteId?: string;
  signal: AbortSignal;
  perRequestMs: number;
}): IntervalsClient {
  return new IntervalsClient({
    apiKey: opts.apiKey,
    athleteId: opts.athleteId,
    fetch: wrapFetchWithSignal({
      baseFetch: globalThis.fetch,
      outer: opts.signal,
      perRequestMs: opts.perRequestMs,
    }),
    retry: { maxAttempts: 1 },
  });
}

/**
 * Chat-path IntervalsClient. Lib-side retry is disabled (`maxAttempts: 1`) so
 * non-idempotent calendar writes (POST/PUT/DELETE) are never replayed by the
 * HTTP layer; transient-failure handling belongs to the caller. `fetch` is
 * injectable for tests — the constructor's `fetch` option is the lib's only
 * injection point (see the note on `makeAbortableClient`).
 */
export function makeChatClient(opts: {
  apiKey: string;
  athleteId?: string;
  fetch?: typeof globalThis.fetch;
}): IntervalsClient {
  return new IntervalsClient({
    apiKey: opts.apiKey,
    athleteId: opts.athleteId,
    fetch: opts.fetch,
    retry: { maxAttempts: 1 },
  });
}
