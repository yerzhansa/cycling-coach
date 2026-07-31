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
 *  2. POSITIVE-ONLY jitter when a server Retry-After hint is supplied. The
 *     default "cap" mode preserves the existing caller ceiling after jitter.
 *     Explicit "lower-bound" mode treats the hint as a true lower bound and
 *     may exceed capMs. Full jitter is never applied to a server hint.
 *
 * `Math.random` is intentionally used here, and this is its only use in core
 * source — a single, contained jitter source.
 */

/** Bounded additive spread (ms) layered on top of a supplied server hint. */
const RETRY_AFTER_JITTER_SPREAD_MS = 1_000;

export interface RetryOptions {
  /** Max total attempts including the first (>= 1). */
  attempts: number;
  /** Base backoff in ms before jitter (the schedule's first interval). */
  baseMs: number;
  /**
   * Ceiling for locally computed exponential backoff. In the default "cap"
   * Retry-After mode it also caps a jittered server hint. A caller that
   * explicitly selects "lower-bound" may wait longer than capMs.
   */
  capMs: number;
  /** Decide whether a thrown error is retryable. */
  shouldRetry: (err: unknown, attempt: number) => boolean;
  /**
   * Server-provided lower-bound wait in ms for this error, or null to fall
   * back to the exponential schedule. When present, jitter is POSITIVE-ONLY
   * (the hint is a lower bound — never sleep less than it).
   */
  retryAfterMs?: (err: unknown) => number | null;
  /**
   * How a valid server Retry-After hint interacts with capMs.
   * Omitted/"cap" preserves the existing caller policy and caps the jittered
   * hint. "lower-bound" preserves the full server hint and may exceed capMs.
   */
  retryAfterMode?: "cap" | "lower-bound";
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
    if (!Number.isSafeInteger(hint) || hint < 0) {
      throw new TypeError("invalid retry-after delay");
    }
    const mode = opts.retryAfterMode ?? "cap";
    if (mode !== "cap" && mode !== "lower-bound") {
      throw new TypeError("invalid retry-after mode");
    }
    const hintedDelayMs = hint + random() * RETRY_AFTER_JITTER_SPREAD_MS;
    if (!Number.isFinite(hintedDelayMs) || hintedDelayMs > Number.MAX_SAFE_INTEGER) {
      throw new TypeError("invalid retry-after delay");
    }
    return mode === "lower-bound" ? hintedDelayMs : Math.min(hintedDelayMs, opts.capMs);
  }
  const interval = Math.min(opts.baseMs * 2 ** (attempt - 1), opts.capMs);
  // Full jitter on the exponential schedule: uniform draw across [0, interval).
  return random() * interval;
}

const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), ([0-9]{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([0-9]{4}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$/;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function validateRetryClock(nowEpochMs: number): void {
  if (!Number.isSafeInteger(nowEpochMs) || nowEpochMs < 0) {
    throw new TypeError("invalid retry clock");
  }
}

export function parseRetryAfterMs(value: string | null, nowEpochMs: number): number | null {
  validateRetryClock(nowEpochMs);
  const normalized = value?.replace(/^[\t ]+|[\t ]+$/g, "") ?? null;
  if (normalized === null || normalized.length === 0) return null;

  if (/^[0-9]+$/.test(normalized)) {
    const seconds = Number.parseInt(normalized, 10);
    const milliseconds = seconds * 1_000;
    return Number.isSafeInteger(seconds) && Number.isSafeInteger(milliseconds)
      ? milliseconds
      : null;
  }

  const match = IMF_FIXDATE.exec(normalized);
  if (match === null) return null;
  const [, weekday, dayText, monthText, yearText, hourText, minuteText, secondText] = match;
  const day = Number(dayText);
  const month = MONTHS.indexOf(monthText as (typeof MONTHS)[number]);
  const year = Number(yearText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const parsedEpochMs = Date.UTC(year, month, day, hour, minute, second);
  const parsed = new Date(parsedEpochMs);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month ||
    parsed.getUTCDate() !== day ||
    parsed.getUTCHours() !== hour ||
    parsed.getUTCMinutes() !== minute ||
    parsed.getUTCSeconds() !== second ||
    WEEKDAYS[parsed.getUTCDay()] !== weekday
  ) {
    return null;
  }
  const difference = parsedEpochMs - nowEpochMs;
  return Number.isSafeInteger(difference) ? Math.max(0, difference) : null;
}

export function retryAfterMsFromHeaders(
  headers: Readonly<Record<string, string>>,
  nowEpochMs: number,
): number | null {
  validateRetryClock(nowEpochMs);
  const matches = Object.keys(headers).filter((key) => {
    const asciiLower = key.replace(/[A-Z]/g, (character) =>
      String.fromCharCode(character.charCodeAt(0) + 32),
    );
    return asciiLower === "retry-after";
  });
  return matches.length === 1 ? parseRetryAfterMs(headers[matches[0]!]!, nowEpochMs) : null;
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
