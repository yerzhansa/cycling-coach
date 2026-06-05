// fixture-privacy-lint:skip-file — this util's regexes and the SYNTHETIC_SHIFT
// constant are synthetic-by-construction (a year offset, not a real date or id),
// but the privacy linter is shape-based and would otherwise have to special-case
// this file. Skip it.

// Shifts ISO date / datetime strings back by a fixed whole-calendar-cycle so a
// committed fixture no longer publishes the real athlete's training calendar
// (race days, rest patterns, the literal week they trained), while preserving
// every metric VALUE exactly.
//
// WHY year -= 28 (and not a fixed day count): 28 years is one full Gregorian
// leap-year cycle. Subtracting 28 from the year maps every calendar date onto
// the SAME month/day/day-of-week with the SAME leap-day structure (2026-02-29
// would be invalid either way; 2024-02-29 -> 1996-02-29 stays valid). Because
// the calendar repeats exactly, every date-to-date day-delta is preserved to the
// day, so monotony / decoupling / rolling-window / curve-window metrics that
// consume temporal structure stay bit-identical in both shape AND value. A naive
// fixed-day subtraction would NOT line up on month/day boundaries and could
// desync the curve windows; the full-cycle year shift avoids that entirely.
//
// 2026 -> 1998, comfortably below the privacy lint's 2015 current-era cutoff.

const YEARS_BACK = 28;

// Matches a date-only (YYYY-MM-DD) head, optionally followed by a datetime
// tail (T..., zone offset, fractional seconds). The tail rides through
// unchanged — only the leading year is shifted. Anchored so a duration like
// "3600" or an arbitrary substring never matches.
const ISO_DATE_HEAD_RE = /^(\d{4})(-\d{2}-\d{2}(?:[T ][0-9:.+\-Z]*)?)$/;

// Matches a curve-block compound id of the form `r.<start>.<end>` where both
// halves are date-only ISO strings. Each embedded year is shifted independently.
const CURVE_BLOCK_ID_RE = /^r\.(\d{4})(-\d{2}-\d{2})\.(\d{4})(-\d{2}-\d{2})$/;

/**
 * Shift a single ISO date / datetime string (or an `r.<date>.<date>` curve id)
 * back by one full Gregorian cycle. Non-date-shaped strings ride through
 * untouched, so duration fields that happen to be strings are never disturbed.
 */
export function shiftIsoToSyntheticEpoch(value: string): string {
  const curve = CURVE_BLOCK_ID_RE.exec(value);
  if (curve !== null) {
    const [, y1, tail1, y2, tail2] = curve;
    return `r.${Number(y1) - YEARS_BACK}${tail1}.${Number(y2) - YEARS_BACK}${tail2}`;
  }
  const m = ISO_DATE_HEAD_RE.exec(value);
  if (m === null) return value;
  const [, year, rest] = m;
  return `${Number(year) - YEARS_BACK}${rest}`;
}

/**
 * Recursively shift every date-shaped string in a JSON value. Used by build
 * scripts whose synthetic date-bearing blocks (curve-window `r.<date>.<date>`
 * ids, fully-synthetic stream dates) are attached AFTER / OUTSIDE the
 * sanitizer's key-keyed walk and so would otherwise carry current-era dates.
 *
 * Object keys are also shifted when they are date-shaped (the streams record is
 * keyed by date in some fixtures); plain numeric values (durations, watts, HR,
 * load) are left untouched because the shift only fires on strings.
 */
export function shiftDatesDeep<T>(value: T): T {
  if (typeof value === "string") {
    return shiftIsoToSyntheticEpoch(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => shiftDatesDeep(item)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[shiftIsoToSyntheticEpoch(key)] = shiftDatesDeep(v);
    }
    return out as unknown as T;
  }
  return value;
}
