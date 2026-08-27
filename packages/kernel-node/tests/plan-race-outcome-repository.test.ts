import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PlanRaceOutcomeValidationError,
  createPlanRaceOutcomeRepository,
  createPlanRepository,
  type PlanRaceOutcomeRecord,
  type PlanRecord,
} from "@enduragent/kernel/planning";
import { runMigrations, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "../src/sqlite/index.js";

const PLAN_ID = `${"0".repeat(25)}1`;

function plan(): PlanRecord {
  return {
    id: PLAN_ID,
    originId: null,
    name: "Gran Fondo Plan",
    primaryGoal: "Finish",
    startDateKey: 19980713,
    targetDateKey: 19981004,
    status: "ended",
    kind: "full_plan",
    totalWeeks: 12,
    weekStartDay: 1,
    structureJson: "{}",
    createdAtMs: 1,
    updatedAtMs: 10,
    deviceId: "device-1",
    hlcPhysicalMs: 10,
    hlcCounter: 0,
  };
}

function outcome(value: PlanRaceOutcomeRecord["outcome"]): PlanRaceOutcomeRecord {
  return {
    planId: PLAN_ID,
    outcome: value,
    recordedAtMs: 20,
    updatedAtMs: 20,
    deviceId: "device-1",
    hlcPhysicalMs: 20,
    hlcCounter: 0,
  };
}

describe("Plan race outcome repository", () => {
  let store: SqlStore & MigratorStore;

  beforeEach(async () => {
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
    await createPlanRepository(store).replace(plan(), []);
  });

  afterEach(async () => {
    await store.close();
  });

  it("persists one terminal outcome across repository recreation", async () => {
    const repository = createPlanRaceOutcomeRepository(store);
    await expect(repository.record(outcome("completed"))).resolves.toMatchObject({
      created: true,
      record: { outcome: "completed" },
    });
    await expect(repository.record(outcome("completed"))).resolves.toMatchObject({
      created: false,
      record: { outcome: "completed" },
    });
    await expect(createPlanRaceOutcomeRepository(store).read(PLAN_ID)).resolves.toMatchObject({
      outcome: "completed",
    });
  });

  it("rejects a conflicting second outcome", async () => {
    const repository = createPlanRaceOutcomeRepository(store);
    await repository.record(outcome("not-completed"));
    await expect(repository.record(outcome("completed"))).rejects.toEqual(
      expect.objectContaining<Partial<PlanRaceOutcomeValidationError>>({
        code: "conflicting-outcome",
      }),
    );
  });
});
