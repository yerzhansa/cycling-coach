import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPlanAdaptationLedgerRepository,
  createPlanRepository,
  createPlanWorkoutDriftRepository,
  encodePlanAdaptationWorkoutSnapshot,
  planAdaptationWorkoutSnapshot,
  type PlanRecord,
  type PlanWorkoutDriftRecord,
  type PlanWorkoutRecord,
} from "@enduragent/kernel/planning";
import { runMigrations, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "../src/sqlite/index.js";

const PLAN_ID = `${"0".repeat(25)}1`;
const WORKOUT_ID = `${"0".repeat(25)}2`;
const DRIFT_ID = `${"0".repeat(25)}3`;

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
  updatedAtMs: 1,
  deviceId: "device-1",
  hlcPhysicalMs: 1,
  hlcCounter: 0,
};

const workout: PlanWorkoutRecord = {
  id: WORKOUT_ID,
  planId: PLAN_ID,
  dateKey: 20260826,
  sport: "cycling",
  name: "Threshold 4×8",
  durationS: 4_800,
  structureJson: "{}",
  origin: "coach",
  deviceId: "device-1",
  hlcPhysicalMs: 1,
  hlcCounter: 0,
};

function drift(overrides: Partial<PlanWorkoutDriftRecord> = {}): PlanWorkoutDriftRecord {
  return {
    id: DRIFT_ID,
    planId: PLAN_ID,
    planWorkoutId: WORKOUT_ID,
    providerEventId: 42,
    providerRevision: "2026-08-26T10:00:00Z",
    status: "detected",
    planSnapshotJson:
      '{"dateKey":20260826,"description":null,"durationS":4800,"name":"Threshold 4×8","workoutDoc":null}',
    providerSnapshotJson:
      '{"dateKey":20260826,"description":null,"durationS":3300,"name":"Threshold 4×8","workoutDoc":null}',
    detectedAtMs: 10,
    observedAtMs: 10,
    resolvedAtMs: null,
    deviceId: "device-1",
    hlcPhysicalMs: 10,
    hlcCounter: 0,
    ...overrides,
  };
}

describe("Plan workout drift repository", () => {
  let store: SqlStore & MigratorStore;

  beforeEach(async () => {
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
    await createPlanRepository(store).replace(plan, [workout]);
  });

  afterEach(async () => {
    await store.close();
  });

  it("keeps one durable unresolved question while provider observations change", async () => {
    const repository = createPlanWorkoutDriftRepository(store);
    await expect(repository.observe(drift())).resolves.toEqual(drift());
    const observed = await repository.observe(
      drift({
        id: `${"0".repeat(25)}4`,
        providerRevision: "2026-08-26T10:05:00Z",
        providerSnapshotJson:
          '{"dateKey":20260826,"description":null,"durationS":3000,"name":"Threshold 4×8","workoutDoc":null}',
        observedAtMs: 15,
        hlcPhysicalMs: 15,
      }),
    );
    expect(observed).toMatchObject({
      id: DRIFT_ID,
      detectedAtMs: 10,
      observedAtMs: 15,
      providerRevision: "2026-08-26T10:05:00Z",
    });
    await expect(repository.readOpenForPlan(PLAN_ID)).resolves.toHaveLength(1);
  });

  it("preserves the resolved decision in history and clears only the open query", async () => {
    const repository = createPlanWorkoutDriftRepository(store);
    await repository.observe(drift());
    await expect(
      repository.resolve({
        id: DRIFT_ID,
        status: "restored",
        resolvedAtMs: 20,
        deviceId: "device-1",
        hlcPhysicalMs: 20,
        hlcCounter: 0,
      }),
    ).resolves.toMatchObject({ status: "restored", resolvedAtMs: 20 });
    await expect(repository.readOpenForWorkout(WORKOUT_ID)).resolves.toBeUndefined();
    await expect(repository.read(DRIFT_ID)).resolves.toMatchObject({ status: "restored" });
  });

  it("adopts the provider snapshot and resolves the drift in one transaction", async () => {
    const plans = createPlanRepository(store);
    const repository = createPlanWorkoutDriftRepository(store);
    const history = createPlanAdaptationLedgerRepository(store);
    const adoptedWorkout = { ...workout, durationS: 3_300, hlcPhysicalMs: 21 };
    await repository.observe(drift());
    await expect(
      repository.adopt({
        id: DRIFT_ID,
        expectedWorkout: workout,
        workout: adoptedWorkout,
        ledger: {
          id: `${"0".repeat(25)}4`,
          planId: PLAN_ID,
          targetWorkoutId: WORKOUT_ID,
          kind: "drift-adopted",
          sourceId: DRIFT_ID,
          reversalOfId: null,
          label: "Intervals edit adopted",
          beforeJson: encodePlanAdaptationWorkoutSnapshot(planAdaptationWorkoutSnapshot(workout)),
          afterJson: encodePlanAdaptationWorkoutSnapshot(
            planAdaptationWorkoutSnapshot(adoptedWorkout),
          ),
          weekLoadBefore: null,
          weekLoadAfter: null,
          occurredAtMs: 21,
          deviceId: "device-1",
          hlcPhysicalMs: 21,
          hlcCounter: 0,
        },
        resolvedAtMs: 21,
        deviceId: "device-1",
        hlcPhysicalMs: 21,
        hlcCounter: 0,
      }),
    ).resolves.toMatchObject({ status: "adopted", resolvedAtMs: 21 });
    await expect(plans.readWorkouts(PLAN_ID)).resolves.toEqual([
      expect.objectContaining({ id: WORKOUT_ID, durationS: 3_300 }),
    ]);
    await expect(repository.readOpenForWorkout(WORKOUT_ID)).resolves.toBeUndefined();
    await expect(history.readForPlan(PLAN_ID)).resolves.toEqual([
      expect.objectContaining({ kind: "drift-adopted", sourceId: DRIFT_ID }),
    ]);
  });
});
