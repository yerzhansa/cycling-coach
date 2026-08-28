import { describe, expect, it } from "vitest";
import {
  GetPlanningReadModelRpcParamsSchema,
  PlanningReadModelSchema,
} from "../src/index.js";

describe("Planning read contract", () => {
  it("accepts a strict no-Plan projection", () => {
    expect(
      PlanningReadModelSchema.parse({
        schemaVersion: 1,
        status: "no-plan",
        asOfDateKey: 20260826,
        plan: null,
      }),
    ).toEqual({ schemaVersion: 1, status: "no-plan", asOfDateKey: 20260826, plan: null });
    expect(GetPlanningReadModelRpcParamsSchema.safeParse({ extra: true }).success).toBe(false);
  });

  it("rejects a today Workout outside the current week projection", () => {
    const workout = {
      id: "workout-1",
      dateKey: 20260826,
      sport: "cycling",
      name: "Tempo",
      durationSeconds: 3600,
      origin: "coach" as const,
      navigation: { destination: "plan" as const, focus: "workout" as const, entityId: "workout-1" },
    };
    const value = {
      schemaVersion: 1,
      status: "ready",
      asOfDateKey: 20260826,
      plan: {
        id: "plan-1",
        name: "Base",
        goal: "Consistency",
        lifecycle: "active",
        startDateKey: 20260824,
        targetDateKey: null,
        currentWeek: 1,
        totalWeeks: 12,
        phase: "Base",
        weekStartDateKey: 20260824,
        weekEndDateKey: 20260830,
        workouts: [],
        todayWorkout: workout,
        navigation: { destination: "plan", focus: "active-plan", entityId: "plan-1" },
      },
    };
    expect(PlanningReadModelSchema.safeParse(value).success).toBe(false);
  });
});
