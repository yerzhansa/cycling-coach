import { describe, expect, it, vi } from "vitest";
import {
  encodePlanAdaptationWorkoutSnapshot,
  planAdaptationWorkoutSnapshot,
  type PlanAdaptationLedgerRecord,
  type PlanAdaptationLedgerRepository,
  type PlanRecord,
  type PlanWorkoutRecord,
} from "@enduragent/kernel/planning";
import {
  applyValidatedPlanUndo,
  PlanUndoError,
  projectPlanHistoryEligibility,
  validatePlanUndo,
} from "../../src/planning/history.js";

const id = (suffix: number): string => String(suffix).padStart(26, "0");
const PLAN_ID = id(1);
const WORKOUT_ID = id(2);

const plan: PlanRecord = {
  id: PLAN_ID,
  originId: null,
  name: "Gran Fondo Plan",
  primaryGoal: "Finish",
  startDateKey: 20260824,
  targetDateKey: 20261004,
  status: "active",
  kind: "full_plan",
  totalWeeks: 6,
  weekStartDay: 1,
  structureJson: "{}",
  createdAtMs: 1,
  updatedAtMs: 20,
  deviceId: "device-1",
  hlcPhysicalMs: 20,
  hlcCounter: 0,
};

const beforeWorkout: PlanWorkoutRecord = {
  id: WORKOUT_ID,
  planId: PLAN_ID,
  dateKey: 20260830,
  sport: "cycling",
  name: "Endurance",
  durationS: 5_400,
  structureJson: "{}",
  origin: "coach",
  deviceId: "device-1",
  hlcPhysicalMs: 10,
  hlcCounter: 0,
};

const currentWorkout: PlanWorkoutRecord = {
  ...beforeWorkout,
  name: "Recovery",
  durationS: 1_800,
  hlcPhysicalMs: 20,
};

function applied(overrides: Partial<PlanAdaptationLedgerRecord> = {}): PlanAdaptationLedgerRecord {
  return {
    id: id(3),
    planId: PLAN_ID,
    targetWorkoutId: WORKOUT_ID,
    kind: "proposal-applied",
    sourceId: id(8),
    reversalOfId: null,
    label: "Sunday recovery applied",
    beforeJson: encodePlanAdaptationWorkoutSnapshot(planAdaptationWorkoutSnapshot(beforeWorkout)),
    afterJson: encodePlanAdaptationWorkoutSnapshot(planAdaptationWorkoutSnapshot(currentWorkout)),
    weekLoadBefore: 420,
    weekLoadAfter: 360,
    occurredAtMs: 20,
    deviceId: "device-1",
    hlcPhysicalMs: 20,
    hlcCounter: 0,
    ...overrides,
  };
}

describe("Plan history Undo policy", () => {
  it("makes only the newest applied change eligible and never searches older entries", () => {
    const newest = applied({ id: id(4), occurredAtMs: 21, hlcPhysicalMs: 21 });
    const result = projectPlanHistoryEligibility({
      plan,
      workouts: [currentWorkout],
      history: [newest, applied()],
      todayDateKey: 20260826,
    });
    expect(result).toEqual([
      { ledgerId: id(4), status: "eligible", reason: null },
      { ledgerId: id(3), status: "expired", reason: "newer-change" },
    ]);
  });

  it.each([
    ["plan-not-active", { plan: { ...plan, status: "ended" as const } }],
    ["workout-missing", { workouts: [] }],
    ["workout-not-future", { workouts: [{ ...currentWorkout, dateKey: 20260826 }] }],
    ["workout-not-coach-owned", { workouts: [{ ...currentWorkout, origin: "athlete" as const }] }],
    ["workout-changed", { workouts: [{ ...currentWorkout, name: "Athlete edit" }] }],
  ] as const)("expires Undo when %s", (reason, overrides) => {
    const eligibility = projectPlanHistoryEligibility({
      plan: "plan" in overrides ? overrides.plan : plan,
      workouts: "workouts" in overrides ? overrides.workouts : [currentWorkout],
      history: [applied()],
      todayDateKey: 20260826,
    });
    expect(eligibility[0]).toEqual({ ledgerId: id(3), status: "expired", reason });
    expect(() =>
      validatePlanUndo({
        ledgerId: id(3),
        plan: "plan" in overrides ? overrides.plan : plan,
        workouts: "workouts" in overrides ? overrides.workouts : [currentWorkout],
        history: [applied()],
        todayDateKey: 20260826,
        deviceId: "device-1",
        hlcPhysicalMs: 30,
        hlcCounter: 0,
      }),
    ).toThrowError(new PlanUndoError("unavailable", reason));
  });

  it("restores the exact before snapshot through one atomic repository reversal", async () => {
    const target = applied();
    const validated = validatePlanUndo({
      ledgerId: target.id,
      plan,
      workouts: [currentWorkout],
      history: [target],
      todayDateKey: 20260826,
      deviceId: "device-2",
      hlcPhysicalMs: 30,
      hlcCounter: 1,
    });
    expect(validated.next).toEqual({
      ...beforeWorkout,
      deviceId: "device-2",
      hlcPhysicalMs: 30,
      hlcCounter: 1,
    });
    const reverse = vi.fn(async (input) => input.undo);
    const repository = { reverse } as unknown as PlanAdaptationLedgerRepository;
    await expect(
      applyValidatedPlanUndo(validated, {
        repository,
        plan,
        undoId: id(5),
        occurredAtMs: 30,
        deviceId: "device-2",
        hlcPhysicalMs: 30,
        hlcCounter: 1,
        mirrorJob: {
          id: id(6),
          windowStartDateKey: 20260826,
          windowEndDateKey: 20260901,
          createdAtMs: 30,
        },
      }),
    ).resolves.toMatchObject({ id: id(5), kind: "undo", reversalOfId: id(3) });
    expect(reverse).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: id(3),
        expectedWorkout: currentWorkout,
        nextWorkout: validated.next,
        undo: expect.objectContaining({
          beforeJson: target.afterJson,
          afterJson: target.beforeJson,
        }),
      }),
    );
  });

  it("does not permit redo or a repeated Undo after an inverse entry", () => {
    const target = applied();
    const undo: PlanAdaptationLedgerRecord = {
      ...target,
      id: id(5),
      kind: "undo",
      sourceId: target.id,
      reversalOfId: target.id,
      beforeJson: target.afterJson,
      afterJson: target.beforeJson,
      weekLoadBefore: target.weekLoadAfter,
      weekLoadAfter: target.weekLoadBefore,
      occurredAtMs: 30,
      hlcPhysicalMs: 30,
    };
    expect(() =>
      validatePlanUndo({
        ledgerId: target.id,
        plan,
        workouts: [beforeWorkout],
        history: [undo, target],
        todayDateKey: 20260826,
        deviceId: "device-1",
        hlcPhysicalMs: 31,
        hlcCounter: 0,
      }),
    ).toThrowError(new PlanUndoError("unavailable", "newer-change"));
    expect(() =>
      validatePlanUndo({
        ledgerId: undo.id,
        plan,
        workouts: [beforeWorkout],
        history: [undo, target],
        todayDateKey: 20260826,
        deviceId: "device-1",
        hlcPhysicalMs: 31,
        hlcCounter: 0,
      }),
    ).toThrowError(new PlanUndoError("unavailable", "already-undone"));
  });
});
