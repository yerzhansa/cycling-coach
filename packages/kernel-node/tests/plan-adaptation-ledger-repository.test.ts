import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPlanAdaptationLedgerRepository,
  createPlanReconciliationRepository,
  createPlanRepository,
  encodePlanAdaptationWorkoutSnapshot,
  planAdaptationWorkoutSnapshot,
  PlanAdaptationLedgerValidationError,
  type PlanAdaptationLedgerRecord,
  type PlanRecord,
  type PlanWorkoutRecord,
} from "@enduragent/kernel/planning";
import { runMigrations, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "../src/sqlite/index.js";

const id = (suffix: number): string => String(suffix).padStart(26, "0");
const PLAN_ID = id(1);
const WORKOUT_ID = id(2);

const plan: PlanRecord = {
  id: PLAN_ID,
  originId: null,
  name: "Gran Fondo Plan",
  primaryGoal: "Finish",
  startDateKey: 20260824,
  targetDateKey: null,
  status: "active",
  kind: "short_race_preparation",
  totalWeeks: 4,
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

const appliedWorkout: PlanWorkoutRecord = {
  ...beforeWorkout,
  name: "Recovery",
  durationS: 1_800,
  hlcPhysicalMs: 20,
};

function appliedRecord(
  overrides: Partial<PlanAdaptationLedgerRecord> = {},
): PlanAdaptationLedgerRecord {
  return {
    id: id(3),
    planId: PLAN_ID,
    targetWorkoutId: WORKOUT_ID,
    kind: "proposal-applied",
    sourceId: id(8),
    reversalOfId: null,
    label: "Sunday recovery applied",
    beforeJson: encodePlanAdaptationWorkoutSnapshot(planAdaptationWorkoutSnapshot(beforeWorkout)),
    afterJson: encodePlanAdaptationWorkoutSnapshot(planAdaptationWorkoutSnapshot(appliedWorkout)),
    weekLoadBefore: 420,
    weekLoadAfter: 360,
    occurredAtMs: 20,
    deviceId: "device-1",
    hlcPhysicalMs: 20,
    hlcCounter: 0,
    ...overrides,
  };
}

function undoRecord(): PlanAdaptationLedgerRecord {
  const applied = appliedRecord();
  return {
    id: id(4),
    planId: PLAN_ID,
    targetWorkoutId: WORKOUT_ID,
    kind: "undo",
    sourceId: applied.id,
    reversalOfId: applied.id,
    label: "Sunday recovery applied undone",
    beforeJson: applied.afterJson,
    afterJson: applied.beforeJson,
    weekLoadBefore: applied.weekLoadAfter,
    weekLoadAfter: applied.weekLoadBefore,
    occurredAtMs: 30,
    deviceId: "device-1",
    hlcPhysicalMs: 30,
    hlcCounter: 0,
  };
}

describe("Plan adaptation ledger repository", () => {
  let store: SqlStore & MigratorStore;

  beforeEach(async () => {
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
    await createPlanRepository(store).replace(plan, [appliedWorkout]);
  });

  afterEach(async () => {
    await store.close();
  });

  it("persists immutable entries in stable newest-first order across repository recreation", async () => {
    const repository = createPlanAdaptationLedgerRepository(store);
    await repository.append(appliedRecord());
    await repository.append(
      appliedRecord({
        id: id(5),
        kind: "drift-adopted",
        sourceId: id(9),
        label: "Intervals edit adopted",
        occurredAtMs: 20,
        hlcPhysicalMs: 21,
      }),
    );

    await expect(createPlanAdaptationLedgerRepository(store).readForPlan(PLAN_ID)).resolves.toEqual(
      [
        expect.objectContaining({ id: id(5), kind: "drift-adopted" }),
        expect.objectContaining({ id: id(3), kind: "proposal-applied" }),
      ],
    );
  });

  it("atomically restores the exact snapshot, appends one inverse, and queues reconciliation", async () => {
    const repository = createPlanAdaptationLedgerRepository(store);
    const plans = createPlanRepository(store);
    const reconciliations = createPlanReconciliationRepository(store);
    await repository.append(appliedRecord());
    const restoredWorkout = {
      ...beforeWorkout,
      deviceId: "device-1",
      hlcPhysicalMs: 30,
      hlcCounter: 0,
    };
    const reverse = {
      targetId: id(3),
      expectedPlanUpdatedAtMs: 20,
      expectedPlanHlcPhysicalMs: 20,
      expectedPlanHlcCounter: 0,
      expectedWorkout: appliedWorkout,
      nextWorkout: restoredWorkout,
      undo: undoRecord(),
      mirrorJob: {
        id: id(6),
        windowStartDateKey: 20260826,
        windowEndDateKey: 20260901,
        createdAtMs: 30,
      },
    } as const;

    await expect(
      repository.reverse({
        ...reverse,
        nextWorkout: { ...restoredWorkout, name: "Not the recorded value" },
      }),
    ).rejects.toEqual(new PlanAdaptationLedgerValidationError("stale-base"));
    await expect(plans.readWorkouts(PLAN_ID)).resolves.toEqual([appliedWorkout]);
    await expect(repository.readForPlan(PLAN_ID)).resolves.toHaveLength(1);

    await expect(repository.reverse(reverse)).resolves.toMatchObject({
      id: id(4),
      kind: "undo",
      reversalOfId: id(3),
    });
    await expect(plans.readWorkouts(PLAN_ID)).resolves.toEqual([restoredWorkout]);
    await expect(repository.readForPlan(PLAN_ID)).resolves.toEqual([
      expect.objectContaining({ id: id(4), kind: "undo" }),
      expect.objectContaining({ id: id(3), kind: "proposal-applied" }),
    ]);
    await expect(reconciliations.readLatestJob(PLAN_ID, "mirror")).resolves.toMatchObject({
      id: id(6),
      status: "pending",
      windowStartDateKey: 20260826,
      windowEndDateKey: 20260901,
    });

    await expect(
      repository.reverse({
        ...reverse,
        undo: { ...undoRecord(), id: id(7), occurredAtMs: 31, hlcPhysicalMs: 31 },
      }),
    ).rejects.toMatchObject({ code: "stale-base" });
    await expect(repository.readForPlan(PLAN_ID)).resolves.toHaveLength(2);
  });
});
