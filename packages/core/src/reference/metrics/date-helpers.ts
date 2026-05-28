/**
 * Reference layer — pure date arithmetic primitives shared across metric
 * modules. Operates on ISO date strings (`YYYY-MM-DD` or
 * `YYYY-MM-DDThh:mm:ss`); conversion to/from millisecond timestamps is
 * hidden inside.
 *
 * Extracted from three near-identical local copies after the F11 batch
 * surfaced the duplication and a divergence in the formatter
 * implementation (two sites used `toISOString().slice(0, 10)`, one
 * used manual `padStart`). The manual formatter is canonical here: it
 * keeps a YYYY-prefixed shape for all years in `[0, 9999]` and never
 * emits the leading `+` that `toISOString` does for year ≥ 10000.
 */

/**
 * Parse an ISO date or datetime string to its UTC ms timestamp. Handles
 * both `YYYY-MM-DD` (treated as midnight UTC) and
 * `YYYY-MM-DDThh:mm:ss` (the time component is used as-is). Used at the
 * benchmark-index date-diff seam where the harness emits a fixture-pinned
 * frozenNow with a time component but FTP history keys are date-only.
 */
export function isoToMs(iso: string): number {
  const datePart = iso.slice(0, 10);
  const timePart = iso.length >= 19 ? iso.slice(11, 19) : "00:00:00";
  const [y, m, d] = datePart.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const [hh, mm, ss] = timePart.split(":").map(Number) as [
    number,
    number,
    number,
  ];
  return Date.UTC(y, m - 1, d, hh, mm, ss);
}

/**
 * Parse a strict `YYYY-MM-DD` string to its midnight-UTC ms timestamp,
 * returning `null` on any deviation from the strict shape, including
 * calendar-invalid dates (Feb 30, Apr 31, etc.) that `Date.UTC` would
 * silently normalise into the following month.
 *
 * Mirrors the upstream Python's `strptime("%Y-%m-%d")` plus `try/except`
 * pattern: malformed entries are dropped, not crashed on. The round-trip
 * check is load-bearing for parity — without it, a fixture key like
 * `"2026-02-30"` would slip into a benchmark window with a March
 * timestamp and bind the wrong FTP value.
 */
export function parseIsoMs(dateStr: string): number | null {
  if (typeof dateStr !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) return null;
  const y = Number(match[1]);
  const mo = Number(match[2]);
  const d = Number(match[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (
    back.getUTCFullYear() !== y ||
    back.getUTCMonth() + 1 !== mo ||
    back.getUTCDate() !== d
  ) {
    return null;
  }
  return ms;
}

/**
 * Format a UTC ms timestamp as `YYYY-MM-DD`. Year is padded to 4 digits
 * for the conventional ISO shape; years outside `[0, 9999]` retain their
 * natural width (no `+`/`-` prefix). Month and day are always 2 digits.
 */
export function formatYmd(ms: number): string {
  const utc = new Date(ms);
  const y = String(utc.getUTCFullYear()).padStart(4, "0");
  const m = String(utc.getUTCMonth() + 1).padStart(2, "0");
  const d = String(utc.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Return the `YYYY-MM-DD` that is `daysBefore` calendar days earlier than
 * `isoNow`'s date prefix. Uses `setUTCDate(-N)` so month and year
 * rollovers are calendar-correct (including leap years).
 */
export function isoDateDaysBefore(
  isoNow: string,
  daysBefore: number,
): string {
  const datePart = isoNow.slice(0, 10);
  const [y, m, d] = datePart.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const utc = new Date(Date.UTC(y, m - 1, d));
  utc.setUTCDate(utc.getUTCDate() - daysBefore);
  return formatYmd(utc.getTime());
}
