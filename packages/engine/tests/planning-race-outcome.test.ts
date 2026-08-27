import { describe, expect, it } from "vitest";
import { naturalPlanCompletionDue, planFinalCivilDateKey, raceOutcomeDue } from "../src/index.js";

const plan = {
  startDateKey: 19980713,
  targetDateKey: 19981004,
  totalWeeks: 12,
  status: "active" as const,
};

describe("Plan completion and race outcome timing", () => {
  it("keeps the Plan active through its final civil date", () => {
    expect(planFinalCivilDateKey(plan)).toBe(19981004);
    expect(naturalPlanCompletionDue(plan, 19981004)).toBe(false);
    expect(naturalPlanCompletionDue(plan, 19981005)).toBe(true);
  });

  it("falls back to the last planned day when no target date exists", () => {
    expect(planFinalCivilDateKey({ ...plan, targetDateKey: null })).toBe(19981004);
  });

  it("waits for post-race sync completion and an unresolved outcome", () => {
    const ended = { status: "ended" as const, targetDateKey: 19981004 };
    expect(
      raceOutcomeDue({
        plan: ended,
        todayDateKey: 19981005,
        awaitingSync: false,
        outcome: undefined,
      }),
    ).toBe(true);
    expect(
      raceOutcomeDue({
        plan: ended,
        todayDateKey: 19981005,
        awaitingSync: true,
        outcome: undefined,
      }),
    ).toBe(false);
    expect(
      raceOutcomeDue({
        plan: ended,
        todayDateKey: 19981005,
        awaitingSync: false,
        outcome: {
          planId: `${"0".repeat(25)}1`,
          outcome: "completed",
          recordedAtMs: 1,
          updatedAtMs: 1,
          deviceId: "device-1",
          hlcPhysicalMs: 1,
          hlcCounter: 0,
        },
      }),
    ).toBe(false);
  });
});
