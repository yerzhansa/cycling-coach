import { IntervalsClient } from "intervals-icu-api";
import type { HttpPort } from "@enduragent/kernel/ports";
import type { PhysicalRequestLedger } from "@enduragent/kernel/store";
import { chainedSignal } from "../../concurrency/abort-budget.js";

export interface RunScopedHttpFactoryArgs {
  readonly outer: AbortSignal;
  readonly perRequestTimeoutMs: number;
}

export type RunScopedHttpFactory = (args: RunScopedHttpFactoryArgs) => HttpPort;

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
  attemptLedger?: PhysicalRequestLedger;
}): typeof globalThis.fetch {
  return async (input, init) => {
    opts.attemptLedger?.charge("legacy", "legacy:reference");
    return await opts.baseFetch(input, {
      ...init,
      signal: opts.outer
        ? chainedSignal({ outer: opts.outer, perRequestMs: opts.perRequestMs })
        : AbortSignal.timeout(opts.perRequestMs),
    });
  };
}

export function makeIntervalsHttpFactory(options: {
  readonly apiKey: string;
  readonly baseFetch?: typeof globalThis.fetch;
}): RunScopedHttpFactory {
  if (typeof options.apiKey !== "string" || options.apiKey.length === 0) {
    throw new TypeError("intervals.icu API key is required");
  }
  const authorization = `Basic ${btoa(`API_KEY:${options.apiKey}`)}`;
  const baseFetch = options.baseFetch ?? globalThis.fetch;
  return ({ outer, perRequestTimeoutMs }) => {
    const fetch = wrapFetchWithSignal({ baseFetch, outer, perRequestMs: perRequestTimeoutMs });
    return {
      async fetch(request) {
        const headers = new Headers(request.headers);
        if (headers.has("authorization")) {
          throw new TypeError("authorization header is managed by the intervals.icu adapter");
        }
        headers.set("authorization", authorization);
        const response = await fetch(request.url, {
          method: request.method,
          headers,
          body:
            typeof request.body === "string"
              ? request.body
              : request.body === undefined
                ? undefined
                : new Uint8Array(request.body),
        });
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          responseHeaders[key.toLowerCase()] = value;
        });
        return {
          status: response.status,
          headers: responseHeaders,
          body: new Uint8Array(await response.arrayBuffer()),
        };
      },
    };
  };
}

/**
 * Per-`runSync` IntervalsClient. Wraps `globalThis.fetch` with the abortable
 * shim above (composed over the shared bucket so the per-request timeout
 * covers queue wait plus HTTP call), and disables lib-side retry
 * (`maxAttempts: 1`) so an outer-timeout resolves as a normalized managed
 * `Network` failure without the lib silently recovering. Reference's own retry-after /
 * rate-limit handling lives at the orchestrator layer (per ADR-0011), not at
 * the client layer.
 *
 * Resource methods do not expose `signal?: AbortSignal`; the constructor's
 * `fetch` option remains the injection point for the operation-scoped signal.
 */
export function makeAbortableClient(opts: {
  apiKey: string;
  athleteId?: string;
  signal: AbortSignal;
  perRequestMs: number;
  attemptLedger?: PhysicalRequestLedger;
}): IntervalsClient {
  return new IntervalsClient({
    apiKey: opts.apiKey,
    athleteId: opts.athleteId,
    fetch: wrapFetchWithSignal({
      baseFetch: wrapFetchWithSharedBucket(globalThis.fetch),
      outer: opts.signal,
      perRequestMs: opts.perRequestMs,
      attemptLedger: opts.attemptLedger,
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
