import {
  MIN_FULL_PLAN_DAYS,
  dateKeyFromText,
  inclusiveCivilDays,
  weekdayForDateKey,
  type PlanKind,
  type PlanStatus,
} from "@enduragent/kernel/planning";

export interface PlanStartDatePreview {
  readonly startDateKey: number;
  readonly targetDateKey: number;
  readonly kind: PlanKind;
  readonly inclusiveDays: number;
  readonly totalWeeks: number;
  readonly weekStartDay: number;
  readonly raceWeekday: number;
  readonly raceDayOfPlanWeek: number;
}

export class PlanStartDateError extends Error {
  readonly code:
    | "start-date-frozen"
    | "start-before-today"
    | "start-after-target"
    | "target-required"
    | "invalid-date";

  constructor(code: PlanStartDateError["code"]) {
    super(`Plan start date rejected: ${code}`);
    this.name = "PlanStartDateError";
    this.code = code;
  }
}

function parseDate(value: string): number {
  try {
    return dateKeyFromText(value);
  } catch {
    throw new PlanStartDateError("invalid-date");
  }
}

export function previewPlanStartDate(input: {
  readonly planStatus: PlanStatus;
  readonly startDate: string;
  readonly today: string;
  readonly targetDate: string | null;
}): PlanStartDatePreview {
  if (input.planStatus !== "draft") throw new PlanStartDateError("start-date-frozen");
  if (input.targetDate === null) throw new PlanStartDateError("target-required");
  const startDateKey = parseDate(input.startDate);
  const todayDateKey = parseDate(input.today);
  const targetDateKey = parseDate(input.targetDate);
  if (startDateKey < todayDateKey) throw new PlanStartDateError("start-before-today");
  if (startDateKey > targetDateKey) throw new PlanStartDateError("start-after-target");
  const days = inclusiveCivilDays(startDateKey, targetDateKey);
  return Object.freeze({
    startDateKey,
    targetDateKey,
    kind: days >= MIN_FULL_PLAN_DAYS ? "full_plan" : "short_race_preparation",
    inclusiveDays: days,
    totalWeeks: Math.ceil(days / 7),
    weekStartDay: weekdayForDateKey(startDateKey),
    raceWeekday: weekdayForDateKey(targetDateKey),
    raceDayOfPlanWeek: ((days - 1) % 7) + 1,
  });
}

export function applyPlanStartDatePreview<
  Plan extends {
    readonly status: PlanStatus;
    readonly startDateKey: number;
    readonly targetDateKey: number | null;
    readonly kind: PlanKind;
    readonly totalWeeks: number;
    readonly weekStartDay: number;
  },
>(plan: Plan, preview: PlanStartDatePreview): Plan {
  if (plan.status !== "draft") throw new PlanStartDateError("start-date-frozen");
  if (plan.targetDateKey !== preview.targetDateKey) throw new PlanStartDateError("invalid-date");
  return Object.freeze({
    ...plan,
    startDateKey: preview.startDateKey,
    kind: preview.kind,
    totalWeeks: preview.totalWeeks,
    weekStartDay: preview.weekStartDay,
  });
}
