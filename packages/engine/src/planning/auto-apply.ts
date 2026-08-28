import { addCivilDays, type PlanRecord } from "@enduragent/kernel/planning";
import type { ValidatedPlanProposal } from "./proposal.js";

export const PLAN_AUTO_APPLY_RACE_WINDOW_DAYS = 7;

export type PlanAutoApplyIneligibleReason =
  | "disabled"
  | "not-a-reduction"
  | "week-structure"
  | "race-window"
  | "taper"
  | "safety-context-unavailable";

export type PlanAutoApplyEligibility =
  | { readonly status: "eligible" }
  | { readonly status: "approval-required"; readonly reason: PlanAutoApplyIneligibleReason };

interface PhaseValue {
  readonly focus: string;
  readonly durationWeeks: number;
}

function phases(value: string): readonly PhaseValue[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const values = (parsed as { phases?: unknown }).phases;
  if (!Array.isArray(values) || values.length === 0) return null;
  const result: PhaseValue[] = [];
  for (const value of values) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const focus = (value as { focus?: unknown }).focus;
    const durationWeeks = (value as { durationWeeks?: unknown }).durationWeeks;
    if (
      typeof focus !== "string" ||
      focus.length === 0 ||
      !Number.isSafeInteger(durationWeeks) ||
      Number(durationWeeks) <= 0
    ) {
      return null;
    }
    result.push({ focus, durationWeeks: Number(durationWeeks) });
  }
  return result;
}

function taperRange(
  plan: PlanRecord,
): { readonly startDateKey: number; readonly endDateKey: number } | null | undefined {
  const values = phases(plan.structureJson);
  if (values === null) return plan.targetDateKey === null ? null : undefined;
  const totalWeeks = values.reduce((total, phase) => total + phase.durationWeeks, 0);
  if (totalWeeks !== plan.totalWeeks) return undefined;
  const taperIndex = values.findIndex((phase) => phase.focus.toLowerCase() === "taper");
  if (taperIndex === -1) return null;
  if (values.slice(taperIndex + 1).some((phase) => phase.focus.toLowerCase() !== "taper")) {
    return undefined;
  }
  const weeksBefore = values
    .slice(0, taperIndex)
    .reduce((total, phase) => total + phase.durationWeeks, 0);
  return {
    startDateKey: addCivilDays(plan.startDateKey, weeksBefore * 7),
    endDateKey: addCivilDays(plan.startDateKey, plan.totalWeeks * 7 - 1),
  };
}

function inRange(value: number, start: number, end: number): boolean {
  return value >= start && value <= end;
}

export function validatePlanAutoApply(input: {
  readonly enabled: boolean;
  readonly plan: PlanRecord;
  readonly proposal: ValidatedPlanProposal;
}): PlanAutoApplyEligibility {
  if (!input.enabled) return { status: "approval-required", reason: "disabled" };
  const change = input.proposal.changes[0];
  if (change === undefined || input.proposal.changes.length !== 1) {
    return { status: "approval-required", reason: "not-a-reduction" };
  }
  if (change.current === null) {
    return { status: "approval-required", reason: "week-structure" };
  }
  if (
    change.next.dateKey !== change.current.dateKey ||
    change.next.sport !== change.current.sport ||
    change.next.name !== change.current.name ||
    change.next.structureJson !== change.current.structureJson
  ) {
    return { status: "approval-required", reason: "week-structure" };
  }
  if (
    change.current.durationS === null ||
    change.next.durationS === null ||
    change.next.durationS >= change.current.durationS
  ) {
    return { status: "approval-required", reason: "not-a-reduction" };
  }
  const taper = taperRange(input.plan);
  if (taper === undefined) {
    return { status: "approval-required", reason: "safety-context-unavailable" };
  }
  if (input.plan.targetDateKey !== null) {
    const raceWindowStart = addCivilDays(
      input.plan.targetDateKey,
      -PLAN_AUTO_APPLY_RACE_WINDOW_DAYS,
    );
    if (inRange(change.current.dateKey, raceWindowStart, input.plan.targetDateKey)) {
      return { status: "approval-required", reason: "race-window" };
    }
  }
  if (taper !== null && inRange(change.current.dateKey, taper.startDateKey, taper.endDateKey)) {
    return { status: "approval-required", reason: "taper" };
  }
  return { status: "eligible" };
}
