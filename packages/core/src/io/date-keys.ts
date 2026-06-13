export const MS_PER_DAY = 86_400_000;

/**
 * Parse a `YYYY-MM-DD` date key to its midnight-UTC epoch-ms.
 * The `T00:00:00Z` suffix is load-bearing: it pins the parse to UTC
 * so the result is timezone-independent. Returns a non-finite value
 * (NaN) for malformed input — callers that need calendar validity use
 * isRealDateKey.
 */
export function parseDateKeyMs(dateKey: string): number {
  return Date.parse(`${dateKey}T00:00:00Z`);
}

/**
 * True iff `dateKey` is a real calendar date in `YYYY-MM-DD` shape.
 * parse → re-format → compare round-trip rejects calendar-invalid dates
 * (e.g. 2026-02-30) that Date.parse would silently normalise.
 */
export function isRealDateKey(dateKey: string): boolean {
  const ms = parseDateKeyMs(dateKey);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === dateKey;
}

/**
 * Inclusive forward iteration over every `YYYY-MM-DD` key in `[from, to]`.
 * Inclusive of BOTH endpoints (mirrors the `+ 1` range-day count). Returns
 * `[]` if either bound is unparseable; assumes `from <= to` lexicographically.
 */
export function eachDateKeyInRange(from: string, to: string): string[] {
  const fromMs = parseDateKeyMs(from);
  const toMs = parseDateKeyMs(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return [];
  const out: string[] = [];
  for (let t = fromMs; t <= toMs; t += MS_PER_DAY) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}
