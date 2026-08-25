import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanningDateError, createPlanRepository } from "@enduragent/kernel/planning";
import { runMigrations, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { createAuthoredIdentity, type AthleteHome } from "../src/home/index.js";
import {
  LEGACY_PLAN_IMPORT_MARKER,
  createLegacyPlanRowWriter,
  importLegacyCurrentPlan,
} from "../src/planning/index.js";
import { openSqliteStorage } from "../src/sqlite/index.js";

function legacyPlan(): Record<string, unknown> {
  return {
    id: "32cc7944-facd-4b56-b1a1-7dfe43e4bfe7",
    name: "8-Week Plan",
    primaryGoal: "Gran Fondo",
    targetDate: "1998-08-30T00:00:00.000Z",
    totalWeeks: 8,
    cycleLength: 7,
    phases: [],
    createdAt: "1998-07-06T12:00:00.000Z",
    status: "draft",
  };
}

describe("legacy current Plan import and dual-write adapter", () => {
  let root: string;
  let home: AthleteHome;
  let store: SqlStore & MigratorStore;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "plan-import-"));
    home = {
      root,
      storeDir: join(root, "store"),
      archiveDir: join(root, "archive"),
      configDir: join(root, "config"),
    };
    await Promise.all([
      mkdir(join(root, "plans"), { recursive: true }),
      mkdir(home.storeDir, { recursive: true }),
      mkdir(home.archiveDir, { recursive: true }),
      mkdir(home.configDir, { recursive: true }),
    ]);
    store = openSqliteStorage(join(home.storeDir, "store.db"));
    await runMigrations(store, MIGRATIONS);
  });

  afterEach(async () => {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("imports the real Draft shape once without modifying its source", async () => {
    const sourcePath = join(root, "plans", "current-plan.json");
    const sourceBytes = Buffer.from(JSON.stringify(legacyPlan(), null, 2));
    await writeFile(sourcePath, sourceBytes);
    const before = await stat(sourcePath);
    const logger = { warn: vi.fn() };
    const identity = createAuthoredIdentity(home.configDir, {
      now: () => 900,
      randomBytes: () => new Uint8Array(10).fill(1),
    });

    const first = await importLegacyCurrentPlan({
      home,
      store,
      identity,
      importDateKey: 19980707,
      importTimestampMs: 900,
      logger,
    });
    const second = await importLegacyCurrentPlan({
      home,
      store,
      identity,
      importDateKey: 19980707,
      importTimestampMs: 900,
      logger,
    });

    expect(first).toEqual({
      status: "imported",
      planId: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
    });
    expect(second).toEqual({ status: "already-completed" });
    const repository = createPlanRepository(store);
    expect(await repository.count()).toBe(1);
    expect(await repository.readByOriginId("32cc7944-facd-4b56-b1a1-7dfe43e4bfe7"))
      .toMatchObject({
        startDateKey: 19980706,
        status: "draft",
        kind: "short_race_preparation",
        totalWeeks: 8,
      });
    expect(await readFile(sourcePath)).toEqual(sourceBytes);
    expect((await stat(sourcePath)).mtimeMs).toBe(before.mtimeMs);
    expect(logger.warn).not.toHaveBeenCalled();
    await expect(readFile(join(home.configDir, LEGACY_PLAN_IMPORT_MARKER), "utf8"))
      .resolves.toBe("completed\n");
  });

  it("logs and skips malformed input without a partial Plan or completion marker", async () => {
    const sourcePath = join(root, "plans", "current-plan.json");
    await writeFile(sourcePath, '{"name":');
    const logger = { warn: vi.fn() };
    const identity = createAuthoredIdentity(home.configDir, {
      now: () => 900,
      randomBytes: () => new Uint8Array(10).fill(2),
    });

    await expect(importLegacyCurrentPlan({
      home,
      store,
      identity,
      importDateKey: 19980707,
      importTimestampMs: 900,
      logger,
    })).resolves.toEqual({ status: "malformed" });
    expect(await createPlanRepository(store).count()).toBe(0);
    expect(logger.warn).toHaveBeenCalledOnce();
    await expect(readFile(join(home.configDir, LEGACY_PLAN_IMPORT_MARKER)))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("falls back to the import date when createdAt is absent or unparseable", async () => {
    const sourcePath = join(root, "plans", "current-plan.json");
    await writeFile(sourcePath, JSON.stringify({
      ...legacyPlan(),
      id: "0a8c6007-d36e-4d44-82d7-5df9fa2db200",
      createdAt: "not-an-instant",
      targetDate: undefined,
    }));
    const identity = createAuthoredIdentity(home.configDir, {
      now: () => 900,
      randomBytes: () => new Uint8Array(10).fill(3),
    });
    await importLegacyCurrentPlan({
      home,
      store,
      identity,
      importDateKey: 19980707,
      importTimestampMs: 900,
      logger: { warn: vi.fn() },
    });
    expect(await createPlanRepository(store).readByOriginId(
      "0a8c6007-d36e-4d44-82d7-5df9fa2db200",
    )).toMatchObject({ startDateKey: 19980707, createdAtMs: 900 });
  });

  it("upserts the same row through repeated compatibility writes", async () => {
    const identity = createAuthoredIdentity(home.configDir, {
      now: () => 900,
      randomBytes: () => new Uint8Array(10).fill(4),
    });
    const repository = createPlanRepository(store);
    const writeRows = await createLegacyPlanRowWriter({
      repository,
      identity,
      fallbackDateKey: () => 19980706,
      now: () => 900,
    });
    await writeRows(legacyPlan());
    await writeRows({ ...legacyPlan(), name: "Updated Plan" });
    expect(await repository.count()).toBe(1);
    expect(await repository.readByOriginId("32cc7944-facd-4b56-b1a1-7dfe43e4bfe7"))
      .toMatchObject({ name: "Updated Plan" });
  });

  it.each([
    [
      "before today",
      "1998-07-05T00:00:00.000Z",
      "1998-08-30T00:00:00.000Z",
      new PlanningDateError("start-before-today"),
    ],
    [
      "after the target",
      "1998-08-31T00:00:00.000Z",
      "1998-08-30T00:00:00.000Z",
      new PlanningDateError("start-after-target"),
    ],
  ])("rejects a new compatibility Plan starting %s", async (_label, startDate, targetDate, error) => {
    const identity = createAuthoredIdentity(home.configDir, {
      now: () => 900,
      randomBytes: () => new Uint8Array(10).fill(5),
    });
    const repository = createPlanRepository(store);
    const writeRows = await createLegacyPlanRowWriter({
      repository,
      identity,
      fallbackDateKey: () => 19980706,
      now: () => 900,
    });

    await expect(writeRows({
      ...legacyPlan(),
      id: undefined,
      startDate,
      targetDate,
    })).rejects.toEqual(error);
    await expect(repository.count()).resolves.toBe(0);
  });
});
