import {
  PlanChatCardReadModelSchema,
  type PlanChatCardReadModel,
  type PlanningReadModel,
  type PlanReferenceSelection,
} from "@enduragent/coach-contract";

export function projectPlanChatCard(
  selection: PlanReferenceSelection,
  planning: PlanningReadModel,
): PlanChatCardReadModel | null {
  if (planning.status !== "ready" || planning.plan.id !== selection.planId) return null;
  const plan = planning.plan;

  if (selection.kind === "active_plan_summary") {
    if (plan.currentWeek === null || plan.phase === null) return null;
    return PlanChatCardReadModelSchema.parse({
      kind: selection.kind,
      cardId: `plan:${plan.id}:summary`,
      planId: plan.id,
      title: plan.name,
      summary: plan.goal.length === 0 ? "No goal recorded" : plan.goal,
      lifecycle: plan.lifecycle,
      currentWeek: plan.currentWeek,
      totalWeeks: plan.totalWeeks,
      phase: plan.phase,
      action: {
        label: "Open Plan",
        target: { destination: "plan", focus: "active-plan", entityId: plan.id },
      },
    });
  }

  if (selection.kind === "current_week") {
    if (plan.currentWeek !== selection.weekNumber || plan.phase === null) return null;
    return PlanChatCardReadModelSchema.parse({
      kind: selection.kind,
      cardId: `plan:${plan.id}:week:${selection.weekNumber}`,
      planId: plan.id,
      title: `Week ${selection.weekNumber} of ${plan.totalWeeks}`,
      summary: plan.phase,
      weekNumber: selection.weekNumber,
      totalWeeks: plan.totalWeeks,
      phase: plan.phase,
      workouts: plan.workouts,
      action: {
        label: "Open Plan",
        target: { destination: "plan", focus: "current-week", entityId: plan.id },
      },
    });
  }

  const workout = plan.workouts.find((candidate) => candidate.id === selection.workoutId);
  if (
    workout === undefined ||
    workout.targets == null ||
    workout.purpose == null ||
    workout.safetyGuardrail == null
  ) {
    return null;
  }
  return PlanChatCardReadModelSchema.parse({
    kind: selection.kind,
    cardId: `plan:${plan.id}:workout:${workout.id}`,
    planId: plan.id,
    workoutId: workout.id,
    title: workout.name,
    summary: workout.sport,
    dateKey: workout.dateKey,
    durationMinutes:
      workout.durationSeconds === null ? null : Math.round(workout.durationSeconds / 60),
    targets: workout.targets,
    purpose: workout.purpose,
    safetyGuardrail: workout.safetyGuardrail,
    applicationState: "current",
    action: { label: "Open Plan", target: workout.navigation },
  });
}
