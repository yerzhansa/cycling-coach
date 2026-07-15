/**
 * One shared retry-with-backoff primitive for the whole core.
 *
 * Two jitter contracts are deliberate and load-bearing:
 *
 *  1. FULL jitter on the exponential schedule — the actual sleep is a uniform
 *     draw from `[0, min(baseMs * 2 ** (attempt - 1), capMs))`. Spreading the
 *     backoff across the whole interval (rather than sleeping the full interval)
 *     de-correlates a herd of clients that would otherwise wake on identical
 *     schedules.
 *  2. POSITIVE-ONLY jitter when a server `Retry-After` hint is honored — the
 *     hint is a *lower bound*, so the sleep is `hint + jitter`, strictly never
 *     below the hint. Full jitter must NOT be applied to a server hint, or a
 *     client could retry before the server told it to.
 *
 * `Math.random` is intentionally used here, and this is its only use in core
 * source — a single, contained jitter source.
 */

/** Bounded additive spread (ms) layered on top of a honored server hint. */
const RETRY_AFTER_JITTER_SPREAD_MS = 1_000;

export interface RetryOptions {
  /** Max total attempts including the first (>= 1). */
  attempts: number;
  /** Base backoff in ms before jitter (the schedule's first interval). */
  baseMs: number;
  /** Hard ceiling for any single backoff in ms (applied before jitter). */
  capMs: number;
  /** Decide whether a thrown error is retryable. */
  shouldRetry: (err: unknown, attempt: number) => boolean;
  /**
   * Server-provided lower-bound wait in ms for this error, or null to fall
   * back to the exponential schedule. When present, jitter is POSITIVE-ONLY
   * (the hint is a lower bound — never sleep less than it).
   */
  retryAfterMs?: (err: unknown) => number | null;
  /** Visibility hook fired before each backoff sleep. */
  onRetry?: (info: { attempt: number; delayMs: number; err: unknown }) => void;
  /** Abortable backoff: an abort resolves the sleep early. */
  signal?: AbortSignal;
  /**
   * Injectable jitter source for deterministic tests; defaults to Math.random.
   * Must return a value in `[0, 1)`.
   */
  random?: () => number;
  /**
   * Injectable backoff sleep for tests; defaults to an abortable setTimeout.
   * Receives the computed (already-jittered) delay in ms.
   */
  sleep?: (ms: number) => Promise<void>;
}

export async function retryWithBackoff<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const random = opts.random ?? Math.random;
  const doSleep = opts.sleep ?? ((ms: number): Promise<void> => abortableSleep(ms, opts.signal));

  let attempt = 0;

  while (true) {
    attempt += 1;
    try {
      return await fn();
    } catch (err) {
      if (attempt >= opts.attempts || !opts.shouldRetry(err, attempt) || opts.signal?.aborted) {
        throw err;
      }

      const delayMs = computeDelayMs(err, attempt, opts, random);
      opts.onRetry?.({ attempt, delayMs, err });
      await doSleep(delayMs);

      if (opts.signal?.aborted) {
        throw err;
      }
    }
  }
}

function computeDelayMs(
  err: unknown,
  attempt: number,
  opts: RetryOptions,
  random: () => number,
): number {
  const hint = opts.retryAfterMs?.(err) ?? null;
  if (hint !== null) {
    // Positive-only jitter: the server hint is a lower bound, never go below it.
    const jittered = hint + random() * RETRY_AFTER_JITTER_SPREAD_MS;
    return Math.min(jittered, opts.capMs);
  }
  const interval = Math.min(opts.baseMs * 2 ** (attempt - 1), opts.capMs);
  // Full jitter on the exponential schedule: uniform draw across [0, interval).
  return random() * interval;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
