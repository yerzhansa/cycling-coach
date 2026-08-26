import { describe, expect, it } from "vitest";
import {
  PlanStartDateError,
  applyPlanStartDatePreview,
  previewPlanStartDate,
} from "../src/planning/start-date.js";

describe("Plan start-date lifecycle", () => {
  it("keeps the 84-inclusive-day boundary as a full Plan", () => {
    expect(
      previewPlanStartDate({
        planStatus: "draft",
        startDate: "2026-07-16",
        today: "2026-07-13",
        targetDate: "2026-10-07",
      }),
    ).toEqual({
      startDateKey: 20260716,
      targetDateKey: 20261007,
      kind: "full_plan",
      inclusiveDays: 84,
      totalWeeks: 12,
      weekStartDay: 4,
      raceWeekday: 3,
      raceDayOfPlanWeek: 7,
    });
  });

  it("keeps a shorter valid selection and labels it as a short block", () => {
    expect(
      previewPlanStartDate({
        planStatus: "draft",
        startDate: "2026-07-20",
        today: "2026-07-13",
        targetDate: "2026-10-04",
      }),
    ).toMatchObject({
      kind: "short_race_preparation",
      inclusiveDays: 77,
      totalWeeks: 11,
      raceWeekday: 0,
    });
  });

  it("allows today and the Goal Event date but rejects dates outside those bounds", () => {
    expect(
      previewPlanStartDate({
        planStatus: "draft",
        startDate: "2026-07-13",
        today: "2026-07-13",
        targetDate: "2026-10-04",
      }).startDateKey,
    ).toBe(20260713);
    expect(
      previewPlanStartDate({
        planStatus: "draft",
        startDate: "2026-10-04",
        today: "2026-07-13",
        targetDate: "2026-10-04",
      }),
    ).toMatchObject({ inclusiveDays: 1, totalWeeks: 1 });
    expect(() =>
      previewPlanStartDate({
        planStatus: "draft",
        startDate: "2026-07-12",
        today: "2026-07-13",
        targetDate: "2026-10-04",
      }),
    ).toThrowError(PlanStartDateError);
    expect(() =>
      previewPlanStartDate({
        planStatus: "draft",
        startDate: "2026-10-05",
        today: "2026-07-13",
        targetDate: "2026-10-04",
      }),
    ).toThrowError(PlanStartDateError);
  });

  it("re-slices a Draft without changing its Goal Event", () => {
    const plan = {
      status: "draft" as const,
      startDateKey: 20260713,
      targetDateKey: 20261004,
      kind: "full_plan" as const,
      totalWeeks: 12,
      weekStartDay: 1,
      name: "Gran Fondo Plan",
    };
    const preview = previewPlanStartDate({
      planStatus: plan.status,
      startDate: "2026-07-20",
      today: "2026-07-13",
      targetDate: "2026-10-04",
    });
    expect(applyPlanStartDatePreview(plan, preview)).toMatchObject({
      startDateKey: 20260720,
      targetDateKey: 20261004,
      kind: "short_race_preparation",
      totalWeeks: 11,
      weekStartDay: 1,
    });
  });

  it("freezes start-date changes after activation", () => {
    expect(() =>
      previewPlanStartDate({
        planStatus: "active",
        startDate: "2026-07-20",
        today: "2026-07-13",
        targetDate: "2026-10-04",
      }),
    ).toThrowError(PlanStartDateError);
  });
});
