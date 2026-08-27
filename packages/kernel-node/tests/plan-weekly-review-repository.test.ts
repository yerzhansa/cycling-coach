import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPlanRepository,
  createPlanWeeklyReviewRepository,
  type PlanRecord,
  type PlanWeeklyReviewRecord,
} from "@enduragent/kernel/planning";
import { runMigrations, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "../src/sqlite/index.js";

const PLAN_ID = `${"0".repeat(25)}1`;
const REVIEW_ID = `${"0".repeat(25)}2`;

function plan(): PlanRecord {
  return {
    id: PLAN_ID,
    originId: null,
    name: "Gran Fondo Plan",
    primaryGoal: "Finish",
    startDateKey: 20260713,
    targetDateKey: 20261004,
    status: "active",
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

function pending(syncAtMs = 100): PlanWeeklyReviewRecord {
  return {
    id: REVIEW_ID,
    planId: PLAN_ID,
    weekStartDateKey: 20260817,
    weekEndDateKey: 20260823,
    status: "pending",
    lastAttemptSyncAtMs: syncAtMs,
    summaryJson: null,
    deliveredAtMs: null,
    createdAtMs: 110,
    updatedAtMs: 110,
    deviceId: "device-1",
    hlcPhysicalMs: 110,
    hlcCounter: 0,
  };
}

describe("Plan weekly review repository", () => {
  let store: SqlStore & MigratorStore;

  beforeEach(async () => {
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
    await createPlanRepository(store).replace(plan(), []);
  });

  afterEach(async () => {
    await store.close();
  });

  it("persists one delivered result per Plan week across repository recreation", async () => {
    const repository = createPlanWeeklyReviewRepository(store);
    await expect(repository.beginAttempt(pending())).resolves.toMatchObject({ started: true });
    await repository.complete({
      id: REVIEW_ID,
      summaryJson: JSON.stringify({ counts: { asPlanned: 3 }, summary: "Last week." }),
      deliveredAtMs: 120,
      updatedAtMs: 120,
      deviceId: "device-1",
      hlcPhysicalMs: 120,
      hlcCounter: 0,
    });

    await expect(
      createPlanWeeklyReviewRepository(store).readLatestDelivered(PLAN_ID),
    ).resolves.toMatchObject({
      id: REVIEW_ID,
      status: "delivered",
      weekStartDateKey: 20260817,
    });
    await expect(repository.beginAttempt(pending(200))).resolves.toMatchObject({
      started: false,
      record: { status: "delivered" },
    });
  });

  it("does not retry a pending delivery on the same sync and permits one newer-sync retry", async () => {
    const repository = createPlanWeeklyReviewRepository(store);
    await expect(repository.beginAttempt(pending(100))).resolves.toMatchObject({ started: true });
    await expect(repository.beginAttempt(pending(100))).resolves.toMatchObject({ started: false });
    await expect(
      repository.beginAttempt({ ...pending(200), id: `${"0".repeat(25)}3`, updatedAtMs: 210 }),
    ).resolves.toMatchObject({
      started: true,
      record: { id: REVIEW_ID, lastAttemptSyncAtMs: 200 },
    });
  });
});
