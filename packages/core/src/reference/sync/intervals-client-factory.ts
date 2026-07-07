import { IntervalsClient } from "intervals-icu-api";
import { chainedSignal } from "../../concurrency/abort-budget.js";

/** Chat-path per-request timeout; mirrors the sync path's PER_REQUEST_TIMEOUT_MS. */
export const CHAT_PER_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Process-wide pacing for every intervals.icu request made through this
 * factory. The lib creates an independent limiter per IntervalsClient
 * instance, so multiple clients (sync + chat) could otherwise burst well
 * past the intended combined rate. One token bucket here — 10 req/s with a
 * burst of 30 — is the single shared budget.
 */
const BUCKET_CAPACITY = 30;
const BUCKET_REFILL_PER_SECOND = 10;

let bucketTokens = BUCKET_CAPACITY;
let bucketLastRefillMs = Date.now();

export function resetSharedRequestBucketForTests(): void {
  bucketTokens = BUCKET_CAPACITY;
  bucketLastRefillMs = Date.now();
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

function abortableDelay(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function acquireRequestToken(signal: AbortSignal | null | undefined): Promise<void> {
  for (;;) {
    if (signal?.aborted) throw abortReason(signal);
    const now = Date.now();
    const elapsedMs = now - bucketLastRefillMs;
    if (elapsedMs > 0) {
      bucketTokens = Math.min(
        BUCKET_CAPACITY,
        bucketTokens + (elapsedMs / 1000) * BUCKET_REFILL_PER_SECOND,
      );
      bucketLastRefillMs = now;
    }
    if (bucketTokens >= 1) {
      bucketTokens -= 1;
      return;
    }
    const waitMs = Math.ceil(((1 - bucketTokens) / BUCKET_REFILL_PER_SECOND) * 1000);
    await abortableDelay(waitMs, signal);
  }
}

/**
 * Route a fetch through the shared process-wide bucket. The queue wait reads
 * `init.signal`, so an abort (per-request timeout or outer cancellation)
 * rejects promptly while still queued rather than waiting for a token.
 */
export function wrapFetchWithSharedBucket(
  baseFetch: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    await acquireRequestToken(init?.signal);
    return baseFetch(input, init);
  };
}

/**
 * Construct a fetch wrapper that injects a chained `AbortSignal` (optional
 * orchestrator signal + per-request timeout) into every request's `init`.
 * Per ADR-0011: one hung endpoint never consumes the orchestrator's full
 * timeout budget.
 *
 * Exported separately from `makeAbortableClient` so tests can verify the
 * wrapper's signal-threading without spinning up a real `IntervalsClient`.
 */
export function wrapFetchWithSignal(opts: {
  baseFetch: typeof globalThis.fetch;
  outer?: AbortSignal;
  perRequestMs: number;
}): typeof globalThis.fetch {
  return (input, init) =>
    opts.baseFetch(input, {
      ...init,
      signal: opts.outer
        ? chainedSignal({ outer: opts.outer, perRequestMs: opts.perRequestMs })
        : AbortSignal.timeout(opts.perRequestMs),
    });
}

/**
 * Per-`runSync` IntervalsClient. Wraps `globalThis.fetch` with the abortable
 * shim above (composed over the shared bucket so the per-request timeout
 * covers queue wait plus HTTP call), and disables lib-side retry
 * (`maxAttempts: 1`) so an outer-timeout abort propagates into `AbortError`
 * without the lib silently recovering. Reference's own retry-after /
 * rate-limit handling lives at the orchestrator layer (per ADR-0011), not at
 * the client layer.
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
      baseFetch: wrapFetchWithSharedBucket(globalThis.fetch),
      outer: opts.signal,
      perRequestMs: opts.perRequestMs,
    }),
    retry: { maxAttempts: 1 },
  });
}

/**
 * Chat-path IntervalsClient. Every request gets the same abortable wrapper as
 * the sync path (30 s per-request timeout covering queue wait plus HTTP call)
 * and flows through the shared bucket. Lib-side retry is disabled
 * (`maxAttempts: 1`) so non-idempotent calendar writes (POST/PUT/DELETE) are
 * never replayed by the HTTP layer; transient-failure handling belongs to the
 * caller. `fetch` is injectable for tests and becomes the base fetch under
 * the wrappers — the constructor's `fetch` option is the lib's only injection
 * point (see the note on `makeAbortableClient`).
 */
export function makeChatClient(opts: {
  apiKey: string;
  athleteId?: string;
  fetch?: typeof globalThis.fetch;
}): IntervalsClient {
  return new IntervalsClient({
    apiKey: opts.apiKey,
    athleteId: opts.athleteId,
    fetch: wrapFetchWithSignal({
      baseFetch: wrapFetchWithSharedBucket(opts.fetch ?? globalThis.fetch),
      perRequestMs: CHAT_PER_REQUEST_TIMEOUT_MS,
    }),
    retry: { maxAttempts: 1 },
  });
}
