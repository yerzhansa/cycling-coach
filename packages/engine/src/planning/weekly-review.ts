import { addCivilDays, inclusiveCivilDays, weekdayForDateKey } from "@enduragent/kernel/planning";
import type { ProjectedWorkoutMatch } from "./workout-match.js";

export const WEEKLY_REVIEW_RACE_QUIET_DAYS = 7 as const;

export interface WeeklyReviewCounts {
  asPlanned: number;
  adjusted: number;
  moved: number;
  missed: number;
  extra: number;
}

export interface WeeklyReviewWindow {
  readonly weekStartDateKey: number;
  readonly weekEndDateKey: number;
}

export function selectWeeklyReviewWindow(input: {
  readonly todayDateKey: number;
  readonly planStartDateKey: number;
  readonly targetDateKey: number | null;
  readonly lastSuccessfulSyncDateKey: number | null;
  readonly enabled: boolean;
}): WeeklyReviewWindow | null {
  if (!input.enabled || input.lastSuccessfulSyncDateKey === null) return null;
  const daysSinceMonday = (weekdayForDateKey(input.todayDateKey) + 6) % 7;
  const currentWeekStart = addCivilDays(input.todayDateKey, -daysSinceMonday);
  if (input.lastSuccessfulSyncDateKey < currentWeekStart) return null;
  if (input.targetDateKey !== null && input.targetDateKey >= input.todayDateKey) {
    const daysToRace = inclusiveCivilDays(input.todayDateKey, input.targetDateKey) - 1;
    if (daysToRace <= WEEKLY_REVIEW_RACE_QUIET_DAYS) return null;
  }
  const weekStartDateKey = addCivilDays(currentWeekStart, -7);
  const weekEndDateKey = addCivilDays(weekStartDateKey, 6);
  if (weekEndDateKey < input.planStartDateKey) return null;
  return Object.freeze({
    weekStartDateKey: Math.max(weekStartDateKey, input.planStartDateKey),
    weekEndDateKey,
  });
}

export function composeWeeklyReview(
  rows: readonly ProjectedWorkoutMatch[],
): { readonly counts: WeeklyReviewCounts; readonly summary: string } | null {
  if (
    rows.some(
      (row) =>
        row.status === "decision-needed" ||
        row.status === "awaiting-sync" ||
        row.status === "upcoming",
    )
  ) {
    return null;
  }
  const counts: WeeklyReviewCounts = {
    asPlanned: 0,
    adjusted: 0,
    moved: 0,
    missed: 0,
    extra: 0,
  };
  for (const row of rows) {
    if (row.status === "as-planned") counts.asPlanned += 1;
    else if (row.status === "adjusted") counts.adjusted += 1;
    else if (row.status === "moved") counts.moved += 1;
    else if (row.status === "missed") counts.missed += 1;
    else if (row.status === "extra") counts.extra += 1;
  }
  const parts = [
    `${counts.asPlanned} as planned`,
    `${counts.adjusted} adjusted`,
    `${counts.moved} moved`,
    `${counts.missed} missed`,
    `${counts.extra} extra`,
  ];
  return Object.freeze({
    counts: Object.freeze(counts),
    summary: `Last week: ${parts.join(", ")}. This is a description, not a score.`,
  });
}

export function orderPlanAttentionItems<
  T extends {
    readonly id: string;
    readonly priority: "blocker" | "dated" | "recent";
    readonly affectedDate: string | null;
    readonly createdAtMs: number;
  },
>(items: readonly T[]): readonly T[] {
  const priority = { blocker: 0, dated: 1, recent: 2 } as const;
  return [...items].sort((left, right) => {
    const priorityDifference = priority[left.priority] - priority[right.priority];
    if (priorityDifference !== 0) return priorityDifference;
    const dateDifference = (left.affectedDate ?? "9999-12-31").localeCompare(
      right.affectedDate ?? "9999-12-31",
    );
    if (dateDifference !== 0) return dateDifference;
    return right.createdAtMs - left.createdAtMs || left.id.localeCompare(right.id);
  });
}
