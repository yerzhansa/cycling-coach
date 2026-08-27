import {
  addCivilDays,
  type PlanRaceOutcomeRecord,
  type PlanRecord,
} from "@enduragent/kernel/planning";

export function planFinalCivilDateKey(
  plan: Pick<PlanRecord, "startDateKey" | "targetDateKey" | "totalWeeks">,
): number {
  return plan.targetDateKey ?? addCivilDays(plan.startDateKey, plan.totalWeeks * 7 - 1);
}

export function naturalPlanCompletionDue(
  plan: Pick<PlanRecord, "startDateKey" | "targetDateKey" | "totalWeeks" | "status">,
  asOfDateKey: number,
): boolean {
  return plan.status === "active" && asOfDateKey > planFinalCivilDateKey(plan);
}

export function raceOutcomeDue(input: {
  readonly plan: Pick<PlanRecord, "status" | "targetDateKey">;
  readonly todayDateKey: number;
  readonly awaitingSync: boolean;
  readonly outcome: PlanRaceOutcomeRecord | undefined;
}): boolean {
  return (
    input.plan.status === "ended" &&
    input.plan.targetDateKey !== null &&
    input.todayDateKey > input.plan.targetDateKey &&
    !input.awaitingSync &&
    input.outcome === undefined
  );
}
