import type { PlanningReadModel } from "@enduragent/coach-contract";
import { describe, expect, it } from "vitest";
import { projectPlanChatCard } from "../src/plan/chat-card.js";

const model: PlanningReadModel = {
  schemaVersion: 1,
  status: "ready",
  asOfDateKey: 20260826,
  plan: {
    id: "plan-1",
    name: "Twelve-week base",
    goal: "Build consistency",
    lifecycle: "active",
    startDateKey: 20260824,
    targetDateKey: null,
    currentWeek: 1,
    totalWeeks: 12,
    phase: "Base",
    weekStartDateKey: 20260824,
    weekEndDateKey: 20260830,
    workouts: [
      {
        id: "workout-1",
        dateKey: 20260826,
        sport: "cycling",
        name: "Tempo builder",
        durationSeconds: 3_600,
        targets: "3 × 8 min · 85–90% FTP",
        purpose: "Sustainable power",
        safetyGuardrail: "Stop if the warm-up feels wrong",
        origin: "coach",
        navigation: { destination: "plan", focus: "workout", entityId: "workout-1" },
      },
    ],
    todayWorkout: null,
    navigation: { destination: "plan", focus: "active-plan", entityId: "plan-1" },
  },
};

describe("Plan Chat card projection", () => {
  it("projects the three frozen read-only card scopes", () => {
    expect(
      projectPlanChatCard({ kind: "active_plan_summary", planId: "plan-1" }, model),
    ).toMatchObject({
      kind: "active_plan_summary",
      title: "Twelve-week base",
      action: { label: "Open Plan", target: { focus: "active-plan" } },
    });
    expect(
      projectPlanChatCard({ kind: "current_week", planId: "plan-1", weekNumber: 1 }, model),
    ).toMatchObject({
      kind: "current_week",
      workouts: [{ id: "workout-1" }],
      action: { label: "Open Plan", target: { focus: "current-week" } },
    });
    expect(
      projectPlanChatCard(
        { kind: "workout_detail", planId: "plan-1", workoutId: "workout-1" },
        model,
      ),
    ).toMatchObject({
      kind: "workout_detail",
      title: "Tempo builder",
      targets: "3 × 8 min · 85–90% FTP",
      purpose: "Sustainable power",
      safetyGuardrail: "Stop if the warm-up feels wrong",
      action: { label: "Open Plan", target: { focus: "workout", entityId: "workout-1" } },
    });
  });

  it("omits stale or incomplete cards instead of synthesizing data", () => {
    expect(projectPlanChatCard({ kind: "active_plan_summary", planId: "stale" }, model)).toBeNull();
    expect(
      projectPlanChatCard({ kind: "current_week", planId: "plan-1", weekNumber: 2 }, model),
    ).toBeNull();
    const incomplete: PlanningReadModel = {
      ...model,
      plan: { ...model.plan, workouts: [{ ...model.plan.workouts[0]!, safetyGuardrail: null }] },
    };
    expect(
      projectPlanChatCard(
        { kind: "workout_detail", planId: "plan-1", workoutId: "workout-1" },
        incomplete,
      ),
    ).toBeNull();
  });
});
