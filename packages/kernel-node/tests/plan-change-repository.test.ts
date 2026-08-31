import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPlanAggregateRepository,
  createPlanChangeRepository,
  createPlanRepository,
  runPlanningTransaction,
  type CreatePlanChangePreviewInput,
  type PlanChangeStatus,
  type PlanRecord,
  type PlanRevisionRecord,
} from "@enduragent/kernel/planning";
import { runMigrations, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "../src/sqlite/index.js";

const syntheticUlid = (suffix: number): string => String(suffix).padStart(26, "0");
const PLAN_ID = syntheticUlid(1);
const INITIAL_REVISION_ID = syntheticUlid(101);
const SECOND_REVISION_ID = syntheticUlid(201);
const FIRST_CHANGE_ID = syntheticUlid(401);
const SECOND_CHANGE_ID = syntheticUlid(402);
const THIRD_CHANGE_ID = syntheticUlid(403);
const FIRST_1998_MS = 903_945_600_000;
const SECOND_1998_MS = 903_949_200_000;
const THIRD_1998_MS = 903_952_800_000;
const FOURTH_1998_MS = 903_956_400_000;
const FIFTH_1998_MS = 903_960_000_000;
const SIXTH_1998_MS = 903_963_600_000;

function legacyPlan(): PlanRecord {
  return {
    id: PLAN_ID,
    originId: null,
    name: "Synthetic 1998 base Plan",
    primaryGoal: "Build steady endurance",
    startDateKey: 19980824,
    targetDateKey: null,
    status: "active",
    kind: "full_plan",
    totalWeeks: 12,
    weekStartDay: 1,
    structureJson: '{"schemaVersion":1}',
    createdAtMs: FIRST_1998_MS,
    updatedAtMs: FIRST_1998_MS,
    deviceId: "synthetic-device-1998",
    hlcPhysicalMs: FIRST_1998_MS,
    hlcCounter: 0,
  };
}

function revision(
  revisionId: string,
  revisionNumber: number,
  createdAtMs: number,
  sourceId = FIRST_CHANGE_ID,
): PlanRevisionRecord {
  return {
    id: revisionId,
    planId: PLAN_ID,
    revisionNumber,
    parentRevisionNumber: revisionNumber === 1 ? null : revisionNumber - 1,
    sourceKind: revisionNumber === 1 ? "migration" : "plan-change",
    sourceId: revisionNumber === 1 ? null : sourceId,
    snapshotJson: JSON.stringify({
      planId: PLAN_ID,
      revisionNumber,
      startDate: "1998-08-24",
    }),
    fingerprint: (revisionNumber === 1 ? "a" : "b").repeat(64),
    createdAtMs,
    deviceId: "synthetic-device-1998",
    hlcPhysicalMs: createdAtMs,
    hlcCounter: 0,
  };
}

function preview(
  changeId: string,
  baseRevisionNumber = 1,
  createdAtMs = SECOND_1998_MS,
): CreatePlanChangePreviewInput {
  return {
    id: changeId,
    planId: PLAN_ID,
    baseRevisionNumber,
    diffJson: JSON.stringify({
      schemaVersion: 1,
      startDate: "1998-08-24",
      operations: [],
    }),
    rationale: "Synthetic 1998 availability changed.",
    premisesJson: '{"schemaVersion":1,"premises":[]}',
    previewFingerprint: (changeId === FIRST_CHANGE_ID
      ? "c"
      : changeId === SECOND_CHANGE_ID
        ? "d"
        : "e"
    ).repeat(64),
    reconciliationEffectJson: '{"schemaVersion":1,"affectedWorkouts":[]}',
    createdAtMs,
    deviceId: "synthetic-device-1998",
    hlcPhysicalMs: createdAtMs,
    hlcCounter: 0,
  };
}

describe("Plan Change repository", () => {
  let store: SqlStore & MigratorStore;
  let aggregate: ReturnType<typeof createPlanAggregateRepository>;
  let repository: ReturnType<typeof createPlanChangeRepository>;

  beforeEach(async () => {
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
    aggregate = createPlanAggregateRepository(store);
    repository = createPlanChangeRepository(store);
    await createPlanRepository(store).replace(legacyPlan(), []);
    await aggregate.register({
      planId: PLAN_ID,
      status: "active",
      activatedAtMs: FIRST_1998_MS,
      closedAtMs: null,
      closeReason: null,
      closeActor: null,
      updatedAtMs: FIRST_1998_MS,
      deviceId: "synthetic-device-1998",
      hlcPhysicalMs: FIRST_1998_MS,
      hlcCounter: 0,
      initialRevision: revision(INITIAL_REVISION_ID, 1, FIRST_1998_MS),
    });
  });

  afterEach(async () => {
    await store.close();
  });

  it("allows one preview per Plan and rejects a stale base revision", async () => {
    const first = await repository.createPreview(preview(FIRST_CHANGE_ID));

    expect(first).toMatchObject({
      id: FIRST_CHANGE_ID,
      status: "preview",
      version: 1,
      baseRevisionNumber: 1,
    });
    await expect(repository.readPreview(PLAN_ID)).resolves.toEqual(first);
    await expect(
      repository.createPreview({
        ...preview(FIRST_CHANGE_ID),
        rationale: "A different synthetic rationale.",
      }),
    ).rejects.toMatchObject({ code: "change-conflict" });
    await expect(repository.createPreview(preview(SECOND_CHANGE_ID))).rejects.toMatchObject({
      code: "change-conflict",
    });
    await expect(repository.read(SECOND_CHANGE_ID)).resolves.toBeUndefined();

    await repository.transition({
      id: FIRST_CHANGE_ID,
      expectedVersion: 1,
      target: "discarded",
      resultRevisionNumber: null,
      terminalAtMs: THIRD_1998_MS,
      updatedAtMs: THIRD_1998_MS,
      deviceId: "synthetic-device-1998",
      hlcPhysicalMs: THIRD_1998_MS,
      hlcCounter: 0,
    });
    await repository.createPreview(preview(SECOND_CHANGE_ID, 1, FOURTH_1998_MS));
    await aggregate.appendRevision({
      planId: PLAN_ID,
      expectedVersion: 1,
      expectedRevisionNumber: 1,
      updatedAtMs: FIFTH_1998_MS,
      deviceId: "synthetic-device-1998",
      hlcPhysicalMs: FIFTH_1998_MS,
      hlcCounter: 0,
      revision: revision(SECOND_REVISION_ID, 2, FIFTH_1998_MS, SECOND_CHANGE_ID),
    });

    await expect(
      repository.createPreview(preview(THIRD_CHANGE_ID, 1, SIXTH_1998_MS)),
    ).rejects.toMatchObject({ code: "stale-change" });
    await expect(repository.read(THIRD_CHANGE_ID)).resolves.toBeUndefined();
  });

  it.each(["stale", "discarded"] satisfies readonly PlanChangeStatus[])(
    "makes %s terminal and immutable",
    async (target) => {
      await repository.createPreview(preview(FIRST_CHANGE_ID));
      if (target === "stale") {
        await expect(
          repository.transition({
            id: FIRST_CHANGE_ID,
            expectedVersion: 1,
            target: "stale",
            resultRevisionNumber: null,
            terminalAtMs: THIRD_1998_MS,
            updatedAtMs: THIRD_1998_MS,
            deviceId: "synthetic-device-1998",
            hlcPhysicalMs: THIRD_1998_MS,
            hlcCounter: 0,
          }),
        ).rejects.toMatchObject({ code: "stale-change" });
        await aggregate.close({
          planId: PLAN_ID,
          expectedVersion: 1,
          reason: "stopped",
          actor: "synthetic-athlete",
          closedAtMs: THIRD_1998_MS,
          updatedAtMs: THIRD_1998_MS,
          deviceId: "synthetic-device-1998",
          hlcPhysicalMs: THIRD_1998_MS,
          hlcCounter: 0,
        });
      } else {
        await expect(
          repository.transition({
            id: FIRST_CHANGE_ID,
            expectedVersion: 1,
            target: "discarded",
            resultRevisionNumber: null,
            terminalAtMs: THIRD_1998_MS,
            updatedAtMs: THIRD_1998_MS,
            deviceId: "synthetic-device-1998",
            hlcPhysicalMs: FIRST_1998_MS,
            hlcCounter: 0,
          }),
        ).rejects.toMatchObject({ code: "stale-change" });
      }

      const terminal = await repository.transition({
        id: FIRST_CHANGE_ID,
        expectedVersion: 1,
        target,
        resultRevisionNumber: null,
        terminalAtMs: THIRD_1998_MS,
        updatedAtMs: THIRD_1998_MS,
        deviceId: "synthetic-device-1998",
        hlcPhysicalMs: THIRD_1998_MS,
        hlcCounter: 0,
      });

      expect(terminal).toMatchObject({
        status: target,
        version: 2,
        resultRevisionNumber: null,
        terminalAtMs: THIRD_1998_MS,
      });
      await expect(repository.readPreview(PLAN_ID)).resolves.toBeUndefined();
      await expect(
        store.run("UPDATE plan_change SET rationale=? WHERE id=?", [
          "Attempted mutation of a terminal synthetic change.",
          FIRST_CHANGE_ID,
        ]),
      ).rejects.toThrow("terminal Plan Change is immutable");
      await expect(
        repository.transition({
          id: FIRST_CHANGE_ID,
          expectedVersion: 2,
          target: target === "stale" ? "discarded" : "stale",
          resultRevisionNumber: null,
          terminalAtMs: FOURTH_1998_MS,
          updatedAtMs: FOURTH_1998_MS,
          deviceId: "synthetic-device-1998",
          hlcPhysicalMs: FOURTH_1998_MS,
          hlcCounter: 0,
        }),
      ).rejects.toMatchObject({ code: "stale-change" });
    },
  );

  it("requires the applied revision to exist and preserves the preview after rejection", async () => {
    const original = await repository.createPreview(preview(FIRST_CHANGE_ID));

    await expect(
      repository.transition({
        id: FIRST_CHANGE_ID,
        expectedVersion: 1,
        target: "applied",
        resultRevisionNumber: 2,
        terminalAtMs: THIRD_1998_MS,
        updatedAtMs: THIRD_1998_MS,
        deviceId: "synthetic-device-1998",
        hlcPhysicalMs: THIRD_1998_MS,
        hlcCounter: 0,
      }),
    ).rejects.toMatchObject({ code: "stale-change" });
    await expect(repository.read(FIRST_CHANGE_ID)).resolves.toEqual(original);
    await expect(repository.readPreview(PLAN_ID)).resolves.toEqual(original);

    await expect(
      runPlanningTransaction(store, async (transaction) => {
        await transaction.plans.appendRevision({
          planId: PLAN_ID,
          expectedVersion: 1,
          expectedRevisionNumber: 1,
          updatedAtMs: THIRD_1998_MS,
          deviceId: "synthetic-device-1998",
          hlcPhysicalMs: THIRD_1998_MS,
          hlcCounter: 0,
          revision: revision(SECOND_REVISION_ID, 2, THIRD_1998_MS),
        });
        await transaction.planChanges.transition({
          id: FIRST_CHANGE_ID,
          expectedVersion: 1,
          target: "applied",
          resultRevisionNumber: 2,
          terminalAtMs: THIRD_1998_MS,
          updatedAtMs: THIRD_1998_MS,
          deviceId: "synthetic-device-1998",
          hlcPhysicalMs: THIRD_1998_MS,
          hlcCounter: 0,
        });
        throw new Error("synthetic apply failure");
      }),
    ).rejects.toThrow("synthetic apply failure");
    await expect(aggregate.read(PLAN_ID)).resolves.toMatchObject({
      version: 1,
      currentRevisionNumber: 1,
    });
    await expect(aggregate.readRevision(PLAN_ID, 2)).resolves.toBeUndefined();
    await expect(repository.read(FIRST_CHANGE_ID)).resolves.toEqual(original);

    const applied = await runPlanningTransaction(store, async (transaction) => {
      await transaction.plans.appendRevision({
        planId: PLAN_ID,
        expectedVersion: 1,
        expectedRevisionNumber: 1,
        updatedAtMs: THIRD_1998_MS,
        deviceId: "synthetic-device-1998",
        hlcPhysicalMs: THIRD_1998_MS,
        hlcCounter: 0,
        revision: revision(SECOND_REVISION_ID, 2, THIRD_1998_MS),
      });
      return transaction.planChanges.transition({
        id: FIRST_CHANGE_ID,
        expectedVersion: 1,
        target: "applied",
        resultRevisionNumber: 2,
        terminalAtMs: THIRD_1998_MS,
        updatedAtMs: THIRD_1998_MS,
        deviceId: "synthetic-device-1998",
        hlcPhysicalMs: THIRD_1998_MS,
        hlcCounter: 0,
      });
    });

    expect(applied).toMatchObject({
      status: "applied",
      version: 2,
      baseRevisionNumber: 1,
      resultRevisionNumber: 2,
      terminalAtMs: THIRD_1998_MS,
    });
    await expect(repository.readPreview(PLAN_ID)).resolves.toBeUndefined();
    await expect(
      store.run("UPDATE plan_change SET rationale=? WHERE id=?", [
        "Attempted mutation of an applied synthetic change.",
        FIRST_CHANGE_ID,
      ]),
    ).rejects.toThrow("terminal Plan Change is immutable");
  });

  it("rejects an unrelated result revision", async () => {
    const original = await repository.createPreview(preview(FIRST_CHANGE_ID));
    await expect(
      aggregate.appendRevision({
        planId: PLAN_ID,
        expectedVersion: 1,
        expectedRevisionNumber: 1,
        updatedAtMs: THIRD_1998_MS,
        deviceId: "synthetic-device-1998",
        hlcPhysicalMs: THIRD_1998_MS,
        hlcCounter: 0,
        revision: revision(SECOND_REVISION_ID, 2, THIRD_1998_MS, SECOND_CHANGE_ID),
      }),
    ).rejects.toMatchObject({ code: "stale-plan" });
    await expect(repository.read(FIRST_CHANGE_ID)).resolves.toEqual(original);
    await expect(aggregate.readRevision(PLAN_ID, 2)).resolves.toBeUndefined();
  });

  it("stales a preview when the Plan closes and rejects a later apply", async () => {
    await repository.createPreview(preview(FIRST_CHANGE_ID));
    await aggregate.close({
      planId: PLAN_ID,
      expectedVersion: 1,
      reason: "stopped",
      actor: "synthetic-athlete",
      closedAtMs: FIFTH_1998_MS,
      updatedAtMs: FIFTH_1998_MS,
      deviceId: "synthetic-device-1998",
      hlcPhysicalMs: FIFTH_1998_MS,
      hlcCounter: 0,
    });
    await expect(
      repository.transition({
        id: FIRST_CHANGE_ID,
        expectedVersion: 1,
        target: "applied",
        resultRevisionNumber: 2,
        terminalAtMs: SIXTH_1998_MS,
        updatedAtMs: SIXTH_1998_MS,
        deviceId: "synthetic-device-1998",
        hlcPhysicalMs: SIXTH_1998_MS,
        hlcCounter: 0,
      }),
    ).rejects.toMatchObject({ code: "stale-change" });
    await expect(repository.read(FIRST_CHANGE_ID)).resolves.toMatchObject({
      status: "stale",
      version: 2,
      resultRevisionNumber: null,
      terminalAtMs: FIFTH_1998_MS,
    });
  });
});
