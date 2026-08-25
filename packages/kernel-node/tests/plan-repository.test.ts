import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPlanAggregateRepository,
  createPlanRepository,
  createPlanWorkoutRepository,
  runMigrations,
  type MigratorStore,
  type PlanRow,
  type PlanWorkoutRow,
  type SqlStore,
} from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "../src/sqlite/index.js";

const PLAN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const WORKOUT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const DEVICE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";

function plan(overrides: Partial<PlanRow> = {}): PlanRow {
  return {
    id: PLAN_ID,
    origin_id: null,
    name: "Eight-week base",
    primary_goal: "Consistency",
    start_date_key: 20260709,
    target_date_key: null,
    status: "draft",
    kind: "short_race_preparation",
    total_weeks: 8,
    week_start_day: 4,
    structure_json: "{}",
    created_at_ms: 1,
    updated_at_ms: 1,
    device_id: DEVICE_ID,
    hlc_physical_ms: 1,
    hlc_counter: 0,
    ...overrides,
  };
}

function workout(overrides: Partial<PlanWorkoutRow> = {}): PlanWorkoutRow {
  return {
    id: WORKOUT_ID,
    plan_id: PLAN_ID,
    date_key: 20260710,
    sport: "cycling",
    name: "Easy endurance",
    duration_s: 3600,
    structure_json: "{}",
    origin: "coach",
    device_id: DEVICE_ID,
    hlc_physical_ms: 2,
    hlc_counter: 0,
    ...overrides,
  };
}

describe("Plan repositories over node:sqlite", () => {
  let store: SqlStore & MigratorStore;

  beforeEach(async () => {
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
  });

  afterEach(async () => {
    await store.close();
  });

  it("atomically stores and reads a Plan aggregate", async () => {
    await createPlanAggregateRepository(store).save(plan(), [workout()]);
    await expect(createPlanRepository(store).read(PLAN_ID)).resolves.toEqual(plan());
    await expect(createPlanWorkoutRepository(store).listForPlan(PLAN_ID)).resolves.toEqual([
      workout(),
    ]);
  });

  it("enforces the Workout foreign key and delete cascade", async () => {
    await expect(createPlanWorkoutRepository(store).upsert(workout())).rejects.toThrow();
    const plans = createPlanRepository(store);
    await plans.upsert(plan());
    await createPlanWorkoutRepository(store).upsert(workout());
    await plans.delete(PLAN_ID);
    await expect(createPlanWorkoutRepository(store).listForPlan(PLAN_ID)).resolves.toEqual([]);
  });

  it.each([
    ["invalid_id", { id: "not-ulid" }],
    ["invalid_status", { status: "paused" }],
    ["invalid_kind", { kind: "block" }],
    ["invalid_total_weeks", { total_weeks: 0 }],
    ["invalid_week_start_day", { week_start_day: 7 }],
    ["inconsistent_week_start_day", { week_start_day: 1 }],
    ["inconsistent_kind", { kind: "full_plan" }],
    ["target_not_covered", { target_date_key: 20261231 }],
  ])("rejects %s with a typed invariant error", async (code, overrides) => {
    await expect(
      createPlanRepository(store).upsert(plan(overrides as Partial<PlanRow>)),
    ).rejects.toMatchObject({ code });
  });

  it("migrates a version-11 store without changing existing rows", async () => {
    const prior = openSqliteStorage(":memory:");
    try {
      await runMigrations(prior, MIGRATIONS.slice(0, 11));
      await prior.run("INSERT INTO raw_file(sha256) VALUES(?)", ["a".repeat(64)]);
      await runMigrations(prior, MIGRATIONS);
      await expect(prior.get("PRAGMA user_version")).resolves.toEqual({ user_version: 13 });
      await expect(prior.get("SELECT sha256 FROM raw_file")).resolves.toEqual({
        sha256: "a".repeat(64),
      });
    } finally {
      await prior.close();
    }
  });
});
