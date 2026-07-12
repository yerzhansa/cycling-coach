import { z } from "zod";
import { isRealDateKey, parseDateKeyMs, MS_PER_DAY } from "../io/date-keys.js";
import { todayInTZ } from "./user-time.js";

export const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const dateKeySchema = z.string().regex(DATE_KEY_RE);
export const INTERVALS_LIST_MAX_RANGE_DAYS = 366;

export function validateListRange(
  oldest: string,
  newest: string | undefined,
  maxDays: number,
): { error: string; details: string } | null {
  if (!isRealDateKey(oldest)) {
    return {
      error: "invalid_date",
      details: `${oldest} is not a real calendar date. Use YYYY-MM-DD.`,
    };
  }
  const effectiveNewest = newest ?? todayInTZ("UTC");
  if (!isRealDateKey(effectiveNewest)) {
    return {
      error: "invalid_date",
      details: `${effectiveNewest} is not a real calendar date. Use YYYY-MM-DD.`,
    };
  }
  if (oldest > effectiveNewest) {
    return {
      error: "invalid_range",
      details: `oldest (${oldest}) is after newest (${effectiveNewest}). Swap the bounds.`,
    };
  }
  const rangeDays =
    (parseDateKeyMs(effectiveNewest) - parseDateKeyMs(oldest)) / MS_PER_DAY + 1;
  if (rangeDays > maxDays) {
    return {
      error: "range_too_wide",
      details: `Range is ${rangeDays} days; the maximum is ${maxDays}. Fetch the range in chunks of at most ${maxDays} days.`,
    };
  }
  return null;
}
