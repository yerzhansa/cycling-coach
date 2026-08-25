import {
  MIN_FULL_PLAN_DAYS,
  MIN_FULL_PLAN_WEEKS,
  PlanningInvariantError,
  type PlanKind,
  type PlanRow,
} from "./types.js";

const MS_PER_DAY = 86_400_000;

function parts(dateKey: number): { year: number; month: number; day: number } {
  if (!Number.isSafeInteger(dateKey)) {
    throw new PlanningInvariantError("invalid_date_key", "date key must be an integer");
  }
  const year = Math.floor(dateKey / 10_000);
  const month = Math.floor((dateKey % 10_000) / 100);
  const day = dateKey % 100;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  if (
    year < 1 ||
    year > 9999 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new PlanningInvariantError("invalid_date_key", "date key is not a real civil date");
  }
  return { year, month, day };
}

function epochDay(dateKey: number): number {
  const { year, month, day } = parts(dateKey);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return Math.floor(date.getTime() / MS_PER_DAY);
}

function fromEpochDay(value: number): number {
  const date = new Date(value * MS_PER_DAY);
  return date.getUTCFullYear() * 10_000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
}

export function addCivilDays(dateKey: number, days: number): number {
  if (!Number.isSafeInteger(days)) {
    throw new PlanningInvariantError("invalid_date_key", "civil-day offset must be an integer");
  }
  return fromEpochDay(epochDay(dateKey) + days);
}

export function civilDaysBetween(startDateKey: number, endDateKey: number): number {
  return epochDay(endDateKey) - epochDay(startDateKey);
}

export function weekdayForDateKey(dateKey: number): number {
  const ordinal = epochDay(dateKey);
  return new Date(ordinal * MS_PER_DAY).getUTCDay();
}

export function derivePlanKind(
  startDateKey: number,
  targetDateKey: number | null,
  totalWeeks: number,
): PlanKind {
  if (targetDateKey !== null) {
    const inclusiveDays = civilDaysBetween(startDateKey, targetDateKey) + 1;
    return inclusiveDays >= MIN_FULL_PLAN_DAYS ? "full_plan" : "short_race_preparation";
  }
  return totalWeeks >= MIN_FULL_PLAN_WEEKS ? "full_plan" : "short_race_preparation";
}

export function minimumWeeksToCover(startDateKey: number, targetDateKey: number): number {
  const offset = civilDaysBetween(startDateKey, targetDateKey);
  if (offset < 0) {
    throw new PlanningInvariantError("start_after_target", "plan start cannot be after target");
  }
  return Math.floor(offset / 7) + 1;
}

export type PlanWeekIndexResult =
  | { readonly kind: "inside"; readonly weekIndex: number }
  | { readonly kind: "outside"; readonly side: "before" | "after" };

export function planWeekIndex(plan: Pick<PlanRow, "start_date_key" | "total_weeks">, dateKey: number): PlanWeekIndexResult {
  const offset = civilDaysBetween(plan.start_date_key, dateKey);
  if (offset < 0) return { kind: "outside", side: "before" };
  const weekIndex = Math.floor(offset / 7) + 1;
  return weekIndex > plan.total_weeks
    ? { kind: "outside", side: "after" }
    : { kind: "inside", weekIndex };
}

export function planWeekRange(
  plan: Pick<PlanRow, "start_date_key" | "total_weeks">,
  weekIndex: number,
): { readonly startDateKey: number; readonly endDateKey: number } {
  if (!Number.isSafeInteger(weekIndex) || weekIndex < 1 || weekIndex > plan.total_weeks) {
    throw new PlanningInvariantError("invalid_total_weeks", "week index is outside the plan");
  }
  const startDateKey = addCivilDays(plan.start_date_key, 7 * (weekIndex - 1));
  return { startDateKey, endDateKey: addCivilDays(startDateKey, 6) };
}

export function validateNewPlanStart(
  startDateKey: number,
  todayDateKey: number,
  targetDateKey: number | null,
): void {
  if (civilDaysBetween(todayDateKey, startDateKey) < 0) {
    throw new PlanningInvariantError("start_before_today", "new plan start cannot be before today");
  }
  if (targetDateKey !== null && civilDaysBetween(startDateKey, targetDateKey) < 0) {
    throw new PlanningInvariantError("start_after_target", "plan start cannot be after target");
  }
}
