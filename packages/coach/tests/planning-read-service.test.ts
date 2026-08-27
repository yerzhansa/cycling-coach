import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPlanRepository } from "@enduragent/kernel/planning";
import { runMigrations, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { createPlanningReadService } from "../src/planning-read-service.js";

const PLAN_ID = "01J60HFQ7T0000000000000000";
const WORKOUT_ID = "01J60HFQ7T0000000000000001";
const NOW = Date.parse("2026-08-26T12:00:00.000Z");

describe("Planning read service", () => {
  let store: SqlStore & MigratorStore;

  beforeEach(async () => {
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
  });

  afterEach(async () => store.close());

  it("returns an explicit no-Plan state", async () => {
    await expect(
      createPlanningReadService({ store, timezone: "UTC", now: () => NOW }).getPlanningReadModel(
        {},
      ),
    ).resolves.toEqual({ schemaVersion: 1, status: "no-plan", asOfDateKey: 20260826, plan: null });
  });

  it("projects the current week, Planning-owned phase, and today Workout", async () => {
    await createPlanRepository(store).replace(
      {
        id: PLAN_ID,
        originId: null,
        name: "Twelve-week base",
        primaryGoal: "Build consistency",
        startDateKey: 20260824,
        targetDateKey: null,
        status: "active",
        kind: "full_plan",
        totalWeeks: 12,
        weekStartDay: 1,
        structureJson: JSON.stringify({
          phases: [
            { name: "Base", durationWeeks: 4 },
            { name: "Build", durationWeeks: 8 },
          ],
        }),
        createdAtMs: NOW - 1_000,
        updatedAtMs: NOW,
        deviceId: "desktop",
        hlcPhysicalMs: NOW,
        hlcCounter: 0,
      },
      [
        {
          id: WORKOUT_ID,
          planId: PLAN_ID,
          dateKey: 20260826,
          sport: "cycling",
          name: "Tempo builder",
          durationS: 3_600,
          structureJson: JSON.stringify({
            targets: "3 × 8 min · 85–90% FTP",
            purpose: "Sustainable power",
            safetyGuardrail: "Stop if the warm-up feels wrong",
          }),
          origin: "coach",
          deviceId: "desktop",
          hlcPhysicalMs: NOW,
          hlcCounter: 1,
        },
      ],
    );

    const result = await createPlanningReadService({
      store,
      timezone: "UTC",
      now: () => NOW,
    }).getPlanningReadModel({});

    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new TypeError();
    expect(result.plan).toMatchObject({
      id: PLAN_ID,
      currentWeek: 1,
      totalWeeks: 12,
      phase: "Base",
      weekStartDateKey: 20260824,
      weekEndDateKey: 20260830,
      todayWorkout: {
        id: WORKOUT_ID,
        name: "Tempo builder",
        targets: "3 × 8 min · 85–90% FTP",
        purpose: "Sustainable power",
        safetyGuardrail: "Stop if the warm-up feels wrong",
      },
    });
    expect(result.plan.workouts).toHaveLength(1);
  });
});
