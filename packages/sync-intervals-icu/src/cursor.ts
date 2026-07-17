import type { SourceLane } from "@enduragent/kernel/store";

export interface RangeCursor {
  readonly v: 1;
  readonly cycle: number;
  readonly window_start: string;
  readonly window_end: string;
  readonly last_key: string | null;
  readonly complete: boolean;
}

export type IndexCursor = RangeCursor;

export interface CursorRange {
  readonly oldest: string;
  readonly newest: string;
}

const DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const CURSOR_KEYS = "v,cycle,window_start,window_end,last_key,complete";

export function parseCivilDate(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("history date is invalid");
  const match = DATE.exec(value);
  if (match === null) throw new TypeError("history date is invalid");
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const instant = new Date(Date.UTC(year, month - 1, day));
  if (instant.getUTCFullYear() !== year || instant.getUTCMonth() !== month - 1 || instant.getUTCDate() !== day) {
    throw new TypeError("history date is invalid");
  }
  return value;
}

export function addUtcDays(value: string, days: number): string {
  parseCivilDate(value);
  if (!Number.isSafeInteger(days)) throw new TypeError("day offset is invalid");
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function compareBinary(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function windowEnd(start: string, newest: string): string {
  const candidate = addUtcDays(start, 364);
  return compareBinary(candidate, newest) < 0 ? candidate : newest;
}

export function initialCursor(lane: SourceLane, range: CursorRange, cycle = 0): RangeCursor {
  const start = lane === "settings" ? range.newest : range.oldest;
  return { v: 1, cycle, window_start: start,
    window_end: lane === "settings" ? range.newest : windowEnd(start, range.newest), last_key: null, complete: false };
}

export function compactCursor(cursor: RangeCursor): string {
  return JSON.stringify({ v: cursor.v, cycle: cursor.cycle, window_start: cursor.window_start,
    window_end: cursor.window_end, last_key: cursor.last_key, complete: cursor.complete });
}

export function parseCursor(value: string | null, lane: SourceLane, range: CursorRange): RangeCursor {
  parseCivilDate(range.oldest); parseCivilDate(range.newest);
  if (compareBinary(range.oldest, range.newest) > 0) throw new TypeError("history range is invalid");
  if (value === null) return initialCursor(lane, range);
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new TypeError("source cursor is invalid"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
    || Object.keys(parsed).join(",") !== CURSOR_KEYS) throw new TypeError("source cursor is invalid");
  const cursor = parsed as Record<string, unknown>;
  if (cursor.v !== 1 || !Number.isSafeInteger(cursor.cycle) || (cursor.cycle as number) < 0
    || (cursor.last_key !== null && typeof cursor.last_key !== "string") || typeof cursor.complete !== "boolean") {
    throw new TypeError("source cursor is invalid");
  }
  const start = parseCivilDate(cursor.window_start), end = parseCivilDate(cursor.window_end);
  const expectedStart = lane === "settings" ? range.newest : start;
  const validWindow = start === expectedStart && end === (lane === "settings" ? range.newest : windowEnd(start, range.newest))
    && compareBinary(start, range.oldest) >= 0 && compareBinary(end, range.newest) <= 0;
  if (!validWindow || (cursor.complete === true && cursor.last_key !== null)) throw new TypeError("source cursor range is invalid");
  const result = { v: 1 as const, cycle: cursor.cycle as number, window_start: start, window_end: end,
    last_key: cursor.last_key as string | null, complete: cursor.complete as boolean };
  if (!result.complete) return result;
  if (lane === "bulk-fit") return result;
  if (result.cycle === Number.MAX_SAFE_INTEGER) throw new TypeError("source cursor cycle is invalid");
  return initialCursor(lane, range, result.cycle + 1);
}

export function advanceWindow(cursor: RangeCursor, range: CursorRange): RangeCursor {
  if (cursor.window_end === range.newest) return { ...cursor, last_key: null, complete: true };
  const start = addUtcDays(cursor.window_end, 1);
  return { ...cursor, window_start: start, window_end: windowEnd(start, range.newest), last_key: null };
}
