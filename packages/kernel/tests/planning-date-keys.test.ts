import { describe, expect, it } from "vitest";
import {
  PlanningDateError,
  addCivilDays,
  dateKeyFromText,
  inclusiveCivilDays,
  planWeekIndex,
  planWeekRange,
  validateNewPlanStartDate,
  weekdayForDateKey,
} from "../src/planning/index.js";

describe("Planning civil dates and Training weeks", () => {
  it.each([
    [20260709, 12, 20260708, { kind: "outside-plan", side: "before" }],
    [20260709, 12, 20260709, { kind: "inside", weekIndex: 1 }],
    [20260709, 12, 20260715, { kind: "inside", weekIndex: 1 }],
    [20260709, 12, 20260716, { kind: "inside", weekIndex: 2 }],
    [20260730, 2, 20260806, { kind: "inside", weekIndex: 2 }],
    [20261229, 2, 20270105, { kind: "inside", weekIndex: 2 }],
    [20260709, 12, 20260930, { kind: "inside", weekIndex: 12 }],
    [20260709, 12, 20261001, { kind: "outside-plan", side: "after" }],
  ] as const)(
    "maps Plan %i/%i and date %i to its Training week",
    (startDateKey, totalWeeks, dateKey, expected) => {
      expect(planWeekIndex({ startDateKey, totalWeeks }, dateKey)).toEqual(expected);
    },
  );

  it("derives the stored weekday from the athlete-selected start date", () => {
    expect(weekdayForDateKey(20260709)).toBe(4);
  });

  it("crosses month and year boundaries without resolving a timezone", () => {
    expect(planWeekRange({ startDateKey: 20261229, totalWeeks: 2 }, 1)).toEqual({
      startDateKey: 20261229,
      endDateKey: 20270104,
    });
    expect(planWeekRange({ startDateKey: 20261229, totalWeeks: 2 }, 2)).toEqual({
      startDateKey: 20270105,
      endDateKey: 20270111,
    });
    expect(addCivilDays(20240228, 1)).toBe(20240229);
    expect(inclusiveCivilDays(20260709, 20260930)).toBe(84);
  });

  it("rejects impossible dates, invalid week indexes, and invalid new starts", () => {
    expect(() => dateKeyFromText("2026-02-30")).toThrow(new PlanningDateError("invalid-date-key"));
    expect(() => planWeekRange({ startDateKey: 20260709, totalWeeks: 2 }, 0))
      .toThrow(new PlanningDateError("invalid-week-index"));
    expect(() => validateNewPlanStartDate(
      { startDateKey: 20260708, targetDateKey: 20261004 },
      20260709,
    )).toThrow(new PlanningDateError("start-before-today"));
    expect(() => validateNewPlanStartDate(
      { startDateKey: 20261005, targetDateKey: 20261004 },
      20260709,
    )).toThrow(new PlanningDateError("start-after-target"));
  });
});
