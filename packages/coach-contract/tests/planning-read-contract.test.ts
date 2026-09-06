import { describe, expect, it } from "vitest";
import {
  GetPlanningReadModelRpcParamsSchema,
  PlanningReadModelSchema,
  ListPlansParamsSchema,
  ListPlansResultSchema,
  PlanSummarySchema,
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
      navigation: {
        destination: "plan" as const,
        focus: "workout" as const,
        entityId: "workout-1",
      },
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

describe("Plan library contract", () => {
  const active = {
    planId: "plan-active",
    name: "Build fitness",
    start: "1998-12-21",
    end: "1999-01-17",
    weeks: 4,
    status: "active",
    closeReason: null,
    closedAt: null,
    activatedAt: "1998-12-20",
    version: 1,
    creationId: "creation-active",
  };

  it("accepts the empty library and strict empty params", () => {
    const empty = { creation: null, active: null, closed: [] };
    expect(ListPlansParamsSchema.parse({})).toEqual({});
    expect(ListPlansResultSchema.parse(empty)).toEqual(empty);
    expect(ListPlansParamsSchema.safeParse({ planId: "extra" }).success).toBe(false);
    expect(ListPlansResultSchema.safeParse({ ...empty, extra: true }).success).toBe(false);
  });

  it.each(["stopped", "completed", "legacy-unclassified"])(
    "accepts %s closed history",
    (closeReason) => {
      const closed = {
        ...active,
        planId: "plan-closed",
        status: "closed",
        closeReason,
        closedAt: "1999-01-18",
        activatedAt: null,
        creationId: null,
      };
      const library = { creation: null, active, closed: [closed] };
      expect(ListPlansResultSchema.parse(library)).toEqual(library);
      expect(ListPlansResultSchema.safeParse({ ...library, active: closed }).success).toBe(false);
      expect(ListPlansResultSchema.safeParse({ ...library, closed: [active] }).success).toBe(false);
    },
  );

  it.each([
    { start: 19981221 },
    { end: "1999-02-30" },
    { closedAt: "1999-01-18T12:00:00Z" },
    { activatedAt: "1998-1-1" },
    { weeks: 0 },
    { status: "draft" },
    { closeReason: "unknown" },
    { creationId: "" },
    { version: 0 },
    { calendarStatus: "healthy" },
  ])("rejects invalid summary fields %j", (fields) => {
    expect(PlanSummarySchema.safeParse({ ...active, ...fields }).success).toBe(false);
  });
});
