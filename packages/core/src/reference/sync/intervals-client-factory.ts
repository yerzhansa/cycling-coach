import { IntervalsClient } from "intervals-icu-api";
import type { HttpPort } from "@enduragent/kernel/ports";
import type { PhysicalRequestLedger } from "@enduragent/kernel/store";
import { chainedSignal } from "../../concurrency/abort-budget.js";

export interface RunScopedHttpFactoryArgs {
  readonly outer: AbortSignal;
  readonly perRequestTimeoutMs: number;
}

export type RunScopedHttpFactory = (args: RunScopedHttpFactoryArgs) => HttpPort;

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
  attemptLedger?: PhysicalRequestLedger;
}): typeof globalThis.fetch {
  return async (input, init) => {
    opts.attemptLedger?.charge("legacy", "legacy:reference");
    return await opts.baseFetch(input, {
      ...init,
      signal: chainedSignal({ outer: opts.outer, perRequestMs: opts.perRequestMs }),
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
  attemptLedger?: PhysicalRequestLedger;
}): IntervalsClient {
  return new IntervalsClient({
    apiKey: opts.apiKey,
    athleteId: opts.athleteId,
    fetch: wrapFetchWithSignal({
      baseFetch: globalThis.fetch,
      outer: opts.signal,
      perRequestMs: opts.perRequestMs,
      attemptLedger: opts.attemptLedger,
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
