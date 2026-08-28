export const MIN_FULL_PLAN_WEEKS = 12 as const;
export const MIN_FULL_PLAN_DAYS = 84 as const;

export class PlanningDateError extends Error {
  readonly code:
    | "invalid-date-key"
    | "invalid-week-index"
    | "start-before-today"
    | "start-after-target";

  constructor(code: PlanningDateError["code"]) {
    super(`planning date rejected: ${code}`);
    this.name = "PlanningDateError";
    this.code = code;
  }
}

const MS_PER_DAY = 86_400_000;

function parts(dateKey: number): { readonly year: number; readonly month: number; readonly day: number } {
  if (!Number.isSafeInteger(dateKey) || dateKey < 10_101 || dateKey > 99_991_231) {
    throw new PlanningDateError("invalid-date-key");
  }
  const year = Math.floor(dateKey / 10_000);
  const month = Math.floor((dateKey % 10_000) / 100);
  const day = dateKey % 100;
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    throw new PlanningDateError("invalid-date-key");
  }
  return { year, month, day };
}

function epochDay(dateKey: number): number {
  const { year, month, day } = parts(dateKey);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return Math.floor(date.getTime() / MS_PER_DAY);
}

function fromEpochDay(value: number): number {
  const date = new Date(value * MS_PER_DAY);
  return date.getUTCFullYear() * 10_000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
}

export function dateKeyFromText(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value)) {
    throw new PlanningDateError("invalid-date-key");
  }
  const dateKey = Number(value.slice(0, 10).replaceAll("-", ""));
  parts(dateKey);
  return dateKey;
}

export function addCivilDays(dateKey: number, days: number): number {
  if (!Number.isSafeInteger(days)) throw new PlanningDateError("invalid-date-key");
  return fromEpochDay(epochDay(dateKey) + days);
}

export function inclusiveCivilDays(startDateKey: number, endDateKey: number): number {
  return epochDay(endDateKey) - epochDay(startDateKey) + 1;
}

export function weekdayForDateKey(dateKey: number): number {
  const { year, month, day } = parts(dateKey);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCDay();
}

export type PlanWeekIndexResult =
  | { readonly kind: "inside"; readonly weekIndex: number }
  | { readonly kind: "outside-plan"; readonly side: "before" | "after" };

export interface PlanWeekSource {
  readonly startDateKey: number;
  readonly totalWeeks: number;
}

export function planWeekIndex(
  plan: PlanWeekSource,
  dateKey: number,
): PlanWeekIndexResult {
  const offset = inclusiveCivilDays(plan.startDateKey, dateKey) - 1;
  if (offset < 0) return { kind: "outside-plan", side: "before" };
  const weekIndex = Math.floor(offset / 7) + 1;
  if (weekIndex > plan.totalWeeks) return { kind: "outside-plan", side: "after" };
  return { kind: "inside", weekIndex };
}

export function planWeekRange(
  plan: PlanWeekSource,
  weekIndex: number,
): { readonly startDateKey: number; readonly endDateKey: number } {
  if (
    !Number.isSafeInteger(weekIndex)
    || weekIndex < 1
    || !Number.isSafeInteger(plan.totalWeeks)
    || weekIndex > plan.totalWeeks
  ) {
    throw new PlanningDateError("invalid-week-index");
  }
  const startDateKey = addCivilDays(plan.startDateKey, (weekIndex - 1) * 7);
  return { startDateKey, endDateKey: addCivilDays(startDateKey, 6) };
}

export function validateNewPlanStartDate(
  plan: { readonly startDateKey: number; readonly targetDateKey: number | null },
  todayDateKey: number,
): void {
  parts(plan.startDateKey);
  parts(todayDateKey);
  if (plan.startDateKey < todayDateKey) throw new PlanningDateError("start-before-today");
  if (plan.targetDateKey !== null) {
    parts(plan.targetDateKey);
    if (plan.startDateKey > plan.targetDateKey) {
      throw new PlanningDateError("start-after-target");
    }
  }
}
