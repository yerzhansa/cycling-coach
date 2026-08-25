import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Memory } from "@enduragent/core";
import { createMemoryTools } from "@enduragent/engine/sport";
import {
  createPlanRepository,
  createPlanWorkoutRepository,
  runMigrations,
  type MigratorStore,
  type SqlStore,
} from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { createAuthoredIdentity } from "@enduragent/kernel-node/home";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { createPlanStorageService } from "../src/plan-storage.js";

const NOW = Date.parse("2026-08-25T12:00:00.000Z");

describe("legacy Plan import and plan_save dual-write", () => {
  let root: string;
  let store: SqlStore & MigratorStore;
  const logger = { info: vi.fn(), warn: vi.fn() };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "plan-storage-"));
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
    logger.info.mockClear();
    logger.warn.mockClear();
  });

  afterEach(async () => {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  });

  function service() {
    return createPlanStorageService({
      store,
      identity: createAuthoredIdentity(join(root, "config"), {
        now: () => NOW,
        randomBytes: () => new Uint8Array(10),
      }),
      timezone: "UTC",
      now: () => NOW,
      logger,
    });
  }

  it("writes the unchanged legacy file and the new Plan row", async () => {
    const memory = new Memory(root);
    const plan = {
      id: "67508c6e-f3bd-4bac-9005-1fbbe8950036",
      name: "Eight-week base",
      primaryGoal: "Consistency",
      totalWeeks: 8,
      createdAt: "2026-08-25T08:00:00.000Z",
      status: "draft",
    };
    const tools = createMemoryTools(memory, [{ name: "goals", description: "Goals" }], {
      planPersistence: service(),
    });
    await tools.plan_save.execute!({ plan }, {} as never);

    expect(readFileSync(join(root, "plans", "current-plan.json"), "utf8")).toBe(
      JSON.stringify(plan, null, 2),
    );
    const rows = await createPlanRepository(store).list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      origin_id: plan.id,
      name: plan.name,
      kind: "short_race_preparation",
      start_date_key: 20260825,
      total_weeks: 8,
    });
  });

  it("surfaces a row-write failure after preserving the legacy file", async () => {
    const memory = new Memory(root);
    const plan = { name: "Safe draft", status: "paused" };
    const tools = createMemoryTools(memory, [{ name: "goals", description: "Goals" }], {
      planPersistence: service(),
    });
    await expect(tools.plan_save.execute!({ plan }, {} as never)).rejects.toMatchObject({
      code: "invalid_status",
    });
    expect(readFileSync(join(root, "plans", "current-plan.json"), "utf8")).toBe(
      JSON.stringify(plan, null, 2),
    );
    await expect(createPlanRepository(store).list()).resolves.toEqual([]);
  });

  it("preserves existing Workout rows when a Plan-only update omits workouts", async () => {
    const storage = service();
    const id = "67508c6e-f3bd-4bac-9005-1fbbe8950036";
    await storage.save({
      id,
      name: "Base",
      totalWeeks: 8,
      createdAt: "2026-08-25T08:00:00.000Z",
      workouts: [{ date: "2026-08-26", sport: "cycling", name: "Endurance" }],
    });
    await storage.save({ id, name: "Renamed base", totalWeeks: 8 });
    const plan = (await createPlanRepository(store).list())[0]!;
    await expect(createPlanWorkoutRepository(store).listForPlan(plan.id)).resolves.toHaveLength(1);
  });

  it("imports the old UUID draft once without touching its source", async () => {
    const plansDir = join(root, "plans");
    mkdirSync(plansDir, { recursive: true });
    const path = join(plansDir, "current-plan.json");
    const draft = {
      id: "67508c6e-f3bd-4bac-9005-1fbbe8950036",
      name: "Legacy draft",
      primaryGoal: "Base fitness",
      totalWeeks: 8,
      status: "draft",
      createdAt: "2026-01-07T10:00:00.000Z",
    };
    const bytes = JSON.stringify(draft, null, 2);
    writeFileSync(path, bytes);
    const storage = service();

    await expect(storage.importLegacyPlan(path)).resolves.toBe("imported");
    await expect(storage.importLegacyPlan(path)).resolves.toBe("already-imported");
    expect(readFileSync(path, "utf8")).toBe(bytes);
    const rows = await createPlanRepository(store).list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
      origin_id: draft.id,
      start_date_key: 20260107,
      kind: "short_race_preparation",
    });
  });

  it("logs and skips malformed legacy JSON without a partial row", async () => {
    const plansDir = join(root, "plans");
    mkdirSync(plansDir, { recursive: true });
    const path = join(plansDir, "current-plan.json");
    writeFileSync(path, "{truncated");
    await expect(service().importLegacyPlan(path)).resolves.toBe("skipped");
    expect(logger.warn).toHaveBeenCalledWith(
      "legacy_plan_import_skipped",
      expect.anything(),
      expect.objectContaining({ reason: "invalid-json" }),
    );
    await expect(createPlanRepository(store).list()).resolves.toEqual([]);
  });
});
