import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPlanRepository,
  createPlanSettingsRepository,
  PlanSettingsValidationError,
  type PlanRecord,
} from "@enduragent/kernel/planning";
import { runMigrations, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "../src/sqlite/index.js";

const PLAN_ID = `${"0".repeat(25)}1`;

function plan(id = PLAN_ID): PlanRecord {
  return {
    id,
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
    updatedAtMs: 10,
    deviceId: "device-1",
    hlcPhysicalMs: 10,
    hlcCounter: 0,
  };
}

describe("Plan settings repository", () => {
  let store: SqlStore & MigratorStore;

  beforeEach(async () => {
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
  });

  afterEach(async () => {
    await store.close();
  });

  it("creates non-inherited defaults for every new Plan and restores them on relaunch", async () => {
    const plans = createPlanRepository(store);
    const firstId = `${"0".repeat(25)}1`;
    const replacementId = `${"0".repeat(25)}2`;
    await plans.replace(plan(firstId), []);
    const settings = createPlanSettingsRepository(store);
    await settings.save({
      planId: firstId,
      setting: "auto-apply",
      value: true,
      expectedUpdatedAtMs: 10,
      expectedHlcPhysicalMs: 10,
      expectedHlcCounter: 0,
      updatedAtMs: 20,
      deviceId: "device-1",
      hlcPhysicalMs: 20,
      hlcCounter: 0,
    });

    await plans.replace(plan(replacementId), []);

    await expect(createPlanSettingsRepository(store).read(firstId)).resolves.toMatchObject({
      autoApply: true,
      weeklyReview: true,
    });
    await expect(createPlanSettingsRepository(store).read(replacementId)).resolves.toMatchObject({
      autoApply: false,
      weeklyReview: true,
    });
  });

  it("saves exactly one control and rejects a stale write", async () => {
    await createPlanRepository(store).replace(plan(), []);
    const settings = createPlanSettingsRepository(store);

    await expect(
      settings.save({
        planId: PLAN_ID,
        setting: "weekly-review",
        value: false,
        expectedUpdatedAtMs: 10,
        expectedHlcPhysicalMs: 10,
        expectedHlcCounter: 0,
        updatedAtMs: 20,
        deviceId: "device-1",
        hlcPhysicalMs: 20,
        hlcCounter: 0,
      }),
    ).resolves.toMatchObject({ autoApply: false, weeklyReview: false });

    await expect(
      settings.save({
        planId: PLAN_ID,
        setting: "auto-apply",
        value: true,
        expectedUpdatedAtMs: 10,
        expectedHlcPhysicalMs: 10,
        expectedHlcCounter: 0,
        updatedAtMs: 21,
        deviceId: "device-1",
        hlcPhysicalMs: 21,
        hlcCounter: 0,
      }),
    ).rejects.toEqual(new PlanSettingsValidationError("stale-settings"));
    await expect(settings.read(PLAN_ID)).resolves.toMatchObject({
      autoApply: false,
      weeklyReview: false,
    });
  });

  it("backfills frozen defaults for Plans created before migration 020", async () => {
    await store.close();
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS.slice(0, 19));
    await createPlanRepository(store).replace(plan(), []);

    await runMigrations(store, MIGRATIONS);

    await expect(createPlanSettingsRepository(store).read(PLAN_ID)).resolves.toMatchObject({
      autoApply: false,
      weeklyReview: true,
      updatedAtMs: 10,
    });
  });
});
