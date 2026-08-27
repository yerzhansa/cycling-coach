import {
  encodePlanAdaptationWorkoutSnapshot,
  parsePlanAdaptationWorkoutSnapshot,
  planAdaptationWorkoutSnapshot,
  type PlanAdaptationLedgerRecord,
  type PlanAdaptationLedgerRepository,
  type PlanRecord,
  type PlanWorkoutRecord,
} from "@enduragent/kernel/planning";

export type PlanUndoUnavailableReason =
  | "newer-change"
  | "plan-not-active"
  | "workout-missing"
  | "workout-not-future"
  | "workout-not-coach-owned"
  | "workout-changed"
  | "already-undone";

export interface PlanHistoryEligibility {
  readonly ledgerId: string;
  readonly status: "eligible" | "expired" | "undone";
  readonly reason: PlanUndoUnavailableReason | null;
}

export interface ValidatedPlanUndo {
  readonly target: PlanAdaptationLedgerRecord;
  readonly current: PlanWorkoutRecord;
  readonly next: PlanWorkoutRecord | null;
}

export class PlanUndoError extends Error {
  readonly code: "unavailable" | "stale-base";
  readonly reason: PlanUndoUnavailableReason;

  constructor(code: PlanUndoError["code"], reason: PlanUndoUnavailableReason) {
    super(`plan undo failed: ${reason}`);
    this.name = "PlanUndoError";
    this.code = code;
    this.reason = reason;
  }
}

function currentSnapshot(workout: PlanWorkoutRecord): string {
  return encodePlanAdaptationWorkoutSnapshot(planAdaptationWorkoutSnapshot(workout));
}

function reasonForTarget(input: {
  readonly plan: PlanRecord;
  readonly target: PlanAdaptationLedgerRecord;
  readonly workout: PlanWorkoutRecord | undefined;
  readonly todayDateKey: number;
}): PlanUndoUnavailableReason | null {
  if (input.plan.status !== "active") return "plan-not-active";
  if (input.workout === undefined) return "workout-missing";
  if (input.workout.dateKey <= input.todayDateKey) return "workout-not-future";
  if (input.workout.origin !== "coach") return "workout-not-coach-owned";
  if (input.target.afterJson === null) return "workout-missing";
  if (currentSnapshot(input.workout) !== input.target.afterJson) return "workout-changed";
  return null;
}

export function projectPlanHistoryEligibility(input: {
  readonly plan: PlanRecord;
  readonly workouts: readonly PlanWorkoutRecord[];
  readonly history: readonly PlanAdaptationLedgerRecord[];
  readonly todayDateKey: number;
}): readonly PlanHistoryEligibility[] {
  const workouts = new Map(input.workouts.map((workout) => [workout.id, workout]));
  const reversals = new Set(
    input.history.flatMap((entry) => (entry.reversalOfId === null ? [] : [entry.reversalOfId])),
  );
  const newest = input.history[0];
  return input.history.map((entry) => {
    if (entry.kind === "undo" || reversals.has(entry.id)) {
      return Object.freeze({
        ledgerId: entry.id,
        status: "undone" as const,
        reason: "already-undone" as const,
      });
    }
    if (newest?.id !== entry.id || newest.kind === "undo") {
      return Object.freeze({
        ledgerId: entry.id,
        status: "expired" as const,
        reason: "newer-change" as const,
      });
    }
    const reason = reasonForTarget({
      plan: input.plan,
      target: entry,
      workout: workouts.get(entry.targetWorkoutId),
      todayDateKey: input.todayDateKey,
    });
    return Object.freeze({
      ledgerId: entry.id,
      status: reason === null ? ("eligible" as const) : ("expired" as const),
      reason,
    });
  });
}

export function validatePlanUndo(input: {
  readonly ledgerId: string;
  readonly plan: PlanRecord;
  readonly workouts: readonly PlanWorkoutRecord[];
  readonly history: readonly PlanAdaptationLedgerRecord[];
  readonly todayDateKey: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}): ValidatedPlanUndo {
  const target = input.history.find((entry) => entry.id === input.ledgerId);
  const newest = input.history[0];
  if (target === undefined) throw new PlanUndoError("unavailable", "newer-change");
  if (target.kind === "undo") throw new PlanUndoError("unavailable", "already-undone");
  if (newest?.id !== target.id) throw new PlanUndoError("unavailable", "newer-change");
  const current = input.workouts.find((workout) => workout.id === target.targetWorkoutId);
  const reason = reasonForTarget({
    plan: input.plan,
    target,
    workout: current,
    todayDateKey: input.todayDateKey,
  });
  if (reason !== null) throw new PlanUndoError("unavailable", reason);
  const before =
    target.beforeJson === null ? null : parsePlanAdaptationWorkoutSnapshot(target.beforeJson);
  return Object.freeze({
    target,
    current: current!,
    next:
      before === null
        ? null
        : Object.freeze({
            ...current!,
            ...before,
            deviceId: input.deviceId,
            hlcPhysicalMs: input.hlcPhysicalMs,
            hlcCounter: input.hlcCounter,
          }),
  });
}

export async function applyValidatedPlanUndo(
  validated: ValidatedPlanUndo,
  input: {
    readonly repository: PlanAdaptationLedgerRepository;
    readonly plan: PlanRecord;
    readonly undoId: string;
    readonly occurredAtMs: number;
    readonly deviceId: string;
    readonly hlcPhysicalMs: number;
    readonly hlcCounter: number;
    readonly mirrorJob: {
      readonly id: string;
      readonly windowStartDateKey: number;
      readonly windowEndDateKey: number;
      readonly createdAtMs: number;
    };
  },
): Promise<PlanAdaptationLedgerRecord> {
  return input.repository.reverse({
    targetId: validated.target.id,
    expectedPlanUpdatedAtMs: input.plan.updatedAtMs,
    expectedPlanHlcPhysicalMs: input.plan.hlcPhysicalMs,
    expectedPlanHlcCounter: input.plan.hlcCounter,
    expectedWorkout: validated.current,
    nextWorkout: validated.next,
    undo: {
      id: input.undoId,
      planId: validated.target.planId,
      targetWorkoutId: validated.target.targetWorkoutId,
      operation: validated.target.operation === "add" ? "remove" : "update",
      kind: "undo",
      sourceId: validated.target.id,
      reversalOfId: validated.target.id,
      label: `${validated.target.label} undone`,
      beforeJson: validated.target.afterJson,
      afterJson: validated.target.beforeJson,
      weekLoadBefore: validated.target.weekLoadAfter,
      weekLoadAfter: validated.target.weekLoadBefore,
      occurredAtMs: input.occurredAtMs,
      deviceId: input.deviceId,
      hlcPhysicalMs: input.hlcPhysicalMs,
      hlcCounter: input.hlcCounter,
    },
    mirrorJob: input.mirrorJob,
  });
}
