import { describe, expect, it } from "vitest";
import {
  addCivilDays,
  derivePlanKind,
  minimumWeeksToCover,
  planWeekIndex,
  planWeekRange,
  validateNewPlanStart,
  weekdayForDateKey,
  PlanningInvariantError,
} from "../src/planning/index.js";

describe("Plan civil-date and training-week rules", () => {
  const plan = { start_date_key: 20260709, total_weeks: 30 };

  it.each([
    [20260708, { kind: "outside", side: "before" }],
    [20260709, { kind: "inside", weekIndex: 1 }],
    [20260715, { kind: "inside", weekIndex: 1 }],
    [20260716, { kind: "inside", weekIndex: 2 }],
    [20260731, { kind: "inside", weekIndex: 4 }],
    [20261231, { kind: "inside", weekIndex: 26 }],
    [20270101, { kind: "inside", weekIndex: 26 }],
  ])("maps %i to its derived week", (dateKey, expected) => {
    expect(planWeekIndex(plan, dateKey)).toEqual(expected);
  });

  it("returns exact seven-day ranges across month and year boundaries", () => {
    expect(planWeekRange(plan, 1)).toEqual({ startDateKey: 20260709, endDateKey: 20260715 });
    const yearBoundary = { start_date_key: 20261229, total_weeks: 2 };
    expect(planWeekRange(yearBoundary, 1)).toEqual({ startDateKey: 20261229, endDateKey: 20270104 });
    expect(addCivilDays(20260228, 1)).toBe(20260301);
  });

  it("derives the week-start weekday and validates real civil dates", () => {
    expect(weekdayForDateKey(20260709)).toBe(4);
    expect(() => weekdayForDateKey(20260230)).toThrowError(PlanningInvariantError);
  });

  it("uses inclusive 84-day lead time and target-covering display weeks", () => {
    expect(derivePlanKind(20260101, 20260324, 12)).toBe("short_race_preparation");
    expect(derivePlanKind(20260101, 20260325, 12)).toBe("full_plan");
    expect(minimumWeeksToCover(20260101, 20260324)).toBe(12);
  });

  it("enforces only the decided bounds for a new start", () => {
    expect(() => validateNewPlanStart(20260825, 20260825, 20260901)).not.toThrow();
    expect(() => validateNewPlanStart(20260824, 20260825, 20260901)).toThrowError(
      expect.objectContaining({ code: "start_before_today" }),
    );
    expect(() => validateNewPlanStart(20260902, 20260825, 20260901)).toThrowError(
      expect.objectContaining({ code: "start_after_target" }),
    );
  });
});
