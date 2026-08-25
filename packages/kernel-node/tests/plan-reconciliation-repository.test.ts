import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  PlanReconciliationValidationError,
  createPlanReconciliationRepository,
  type PlanReconciliationRepository,
} from "@enduragent/kernel/planning";
import { runMigrations, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "../src/sqlite/index.js";

const PLAN_ID = "01K00000000000000000000001";
const WORKOUT_ID = "01K00000000000000000000002";
const JOB_ID = "01K00000000000000000000003";
const ITEM_ID = "01K00000000000000000000004";

async function seedPlan(store: SqlStore): Promise<void> {
  await store.run(
    `INSERT INTO plan (
      id,origin_id,name,primary_goal,start_date_key,target_date_key,status,kind,total_weeks,
      week_start_day,structure_json,created_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [PLAN_ID, null, "Synthetic Plan", "Synthetic goal", 20260824, 20261115, "active",
      "short_race_preparation", 12, 1, "{}", 1, 1, "device", 1, 0],
  );
  await store.run(
    `INSERT INTO plan_workout (
      id,plan_id,date_key,sport,name,duration_s,structure_json,origin,device_id,hlc_physical_ms,hlc_counter
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [WORKOUT_ID, PLAN_ID, 20260825, "cycling", "Endurance", 3600, "{}", "coach", "device", 1, 0],
  );
}

function job() {
  return {
    id: JOB_ID,
    planId: PLAN_ID,
    kind: "mirror" as const,
    windowStartDateKey: 20260825,
    windowEndDateKey: 20260831,
    createdAtMs: 10,
  };
}

function item(expectedJson = "{}") {
  return {
    id: ITEM_ID,
    jobId: JOB_ID,
    planWorkoutId: WORKOUT_ID,
    operation: "create" as const,
    dateKey: 20260825,
    externalId: `cycling-coach:plan:${PLAN_ID}:${WORKOUT_ID}`,
    expectedJson,
    createdAtMs: 10,
  };
}

describe("Plan reconciliation repository", () => {
  let store: (SqlStore & MigratorStore) | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    await store?.close();
    store = undefined;
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  async function fresh(): Promise<PlanReconciliationRepository> {
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
    await seedPlan(store);
    return createPlanReconciliationRepository(store);
  }

  it("persists a pending job and every item before the first attempt", async () => {
    const repository = await fresh();
    const savedJob = await repository.createOrGetJob(job());
    const savedItem = await repository.prepareItem(item());
    expect(savedJob).toMatchObject({
      status: "pending",
      attemptCount: 0,
      failureCount: 0,
      resumedCount: 0,
      lastResumedAttempt: null,
    });
    expect(savedItem).toMatchObject({ status: "pending", attemptCount: 0 });
    expect(await repository.readItems(JOB_ID)).toEqual([savedItem]);
  });

  it("tracks first failure retry repeated failure and final verification", async () => {
    const repository = await fresh();
    await repository.createOrGetJob(job());
    await repository.prepareItem(item());
    await repository.beginAttempt(JOB_ID, 11);
    await repository.startItem(ITEM_ID, 12);
    await repository.failItem(ITEM_ID, "calendar-create-failed", 13);
    expect(await repository.failJob(JOB_ID, "calendar-create-failed", 14)).toMatchObject({
      status: "failed",
      attemptCount: 1,
      failureCount: 1,
    });
    await repository.beginAttempt(JOB_ID, 15);
    await repository.startItem(ITEM_ID, 16);
    await repository.failItem(ITEM_ID, "calendar-verification-failed", 17);
    expect(await repository.failJob(JOB_ID, "calendar-verification-failed", 18)).toMatchObject({
      status: "failed",
      attemptCount: 2,
      failureCount: 2,
    });
    await repository.beginAttempt(JOB_ID, 19);
    await repository.startItem(ITEM_ID, 20);
    expect(await repository.markItemCreated(ITEM_ID, 21)).toMatchObject({ status: "created" });
    await repository.verifyItem(ITEM_ID, 42, 22);
    expect(await repository.verifyJob(JOB_ID, 23)).toMatchObject({
      status: "verified",
      attemptCount: 3,
      completedAtMs: 23,
    });
  });

  it("refuses to verify a job while any item is incomplete", async () => {
    const repository = await fresh();
    await repository.createOrGetJob(job());
    await repository.prepareItem(item());
    await repository.beginAttempt(JOB_ID, 11);
    await expect(repository.verifyJob(JOB_ID, 12)).rejects.toEqual(
      new PlanReconciliationValidationError("unverified-items"),
    );
  });

  it("rejects terminal job transitions before an attempt or after verification", async () => {
    const repository = await fresh();
    await repository.createOrGetJob(job());
    await expect(repository.failJob(JOB_ID, "calendar-list-failed", 11)).rejects.toEqual(
      new PlanReconciliationValidationError("invalid-job"),
    );
    await expect(repository.verifyJob(JOB_ID, 11)).rejects.toEqual(
      new PlanReconciliationValidationError("invalid-job"),
    );
    await repository.beginAttempt(JOB_ID, 12);
    await repository.verifyJob(JOB_ID, 13);
    await expect(repository.failJob(JOB_ID, "calendar-list-failed", 14)).rejects.toEqual(
      new PlanReconciliationValidationError("invalid-job"),
    );
  });

  it("requires provider identity only for verified creates", async () => {
    const repository = await fresh();
    await repository.createOrGetJob(job());
    await repository.prepareItem(item());
    await expect(repository.verifyItem(ITEM_ID, null, 11)).rejects.toEqual(
      new PlanReconciliationValidationError("invalid-item"),
    );
    const deleteItemId = "01K00000000000000000000005";
    await repository.prepareItem({
      ...item(),
      id: deleteItemId,
      planWorkoutId: null,
      operation: "delete",
      externalId: `${item().externalId}:delete`,
    });
    await expect(repository.verifyItem(deleteItemId, 42, 11)).rejects.toEqual(
      new PlanReconciliationValidationError("invalid-item"),
    );
    await expect(repository.verifyItem(deleteItemId, null, 11)).resolves.toMatchObject({
      status: "verified",
      providerEventId: null,
    });
  });

  it("removes obsolete create items when a Plan workout is replaced", async () => {
    const repository = await fresh();
    await repository.createOrGetJob(job());
    await repository.prepareItem(item());
    await store!.run("DELETE FROM plan_workout WHERE id=?", [WORKOUT_ID]);
    await expect(repository.readItems(JOB_ID)).resolves.toEqual([]);
  });

  it("resets a verified item when its expected payload changes", async () => {
    const repository = await fresh();
    await repository.createOrGetJob(job());
    await repository.prepareItem(item('{"durationS":3600}'));
    await repository.verifyItem(ITEM_ID, 42, 11);
    const changed = await repository.prepareItem({
      ...item('{"durationS":1800}'),
      id: "01K00000000000000000000005",
      createdAtMs: 12,
    });
    expect(changed).toMatchObject({
      id: ITEM_ID,
      status: "pending",
      providerEventId: null,
      expectedJson: '{"durationS":1800}',
    });
  });

  it("marks an interrupted running job as resumed on the next attempt after relaunch", async () => {
    directory = await mkdtemp(join(tmpdir(), "plan-reconcile-"));
    const path = join(directory, "store.db");
    store = openSqliteStorage(path);
    await runMigrations(store, MIGRATIONS);
    await seedPlan(store);
    let repository = createPlanReconciliationRepository(store);
    await repository.createOrGetJob(job());
    await repository.prepareItem(item());
    await repository.beginAttempt(JOB_ID, 11);
    await repository.startItem(ITEM_ID, 12);
    await store.close();
    store = openSqliteStorage(path);
    repository = createPlanReconciliationRepository(store);
    expect(await repository.beginAttempt(JOB_ID, 13)).toMatchObject({
      status: "running",
      attemptCount: 2,
      resumedCount: 1,
      lastResumedAttempt: 2,
    });
    expect(await repository.readItems(JOB_ID)).toMatchObject([{ status: "running" }]);
  });

  it("rejects invalid jobs and items before storage", async () => {
    const repository = await fresh();
    await expect(repository.createOrGetJob({ ...job(), windowEndDateKey: 20260824 }))
      .rejects.toEqual(new PlanReconciliationValidationError("invalid-job"));
    await expect(repository.createOrGetJob({ ...job(), windowStartDateKey: 20260230 }))
      .rejects.toEqual(new PlanReconciliationValidationError("invalid-job"));
    await repository.createOrGetJob(job());
    await expect(repository.prepareItem({ ...item(), externalId: "" }))
      .rejects.toEqual(new PlanReconciliationValidationError("invalid-item"));
  });
});
