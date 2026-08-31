import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPlanAggregateRepository,
  createPlanChangeRepository,
  createPlanRepository,
  PLAN_COMPLETION_ACTOR,
  type PlanRecord,
  type PlanRevisionRecord,
  type RegisterPlanAggregateInput,
} from "@enduragent/kernel/planning";
import { runMigrations, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "../src/sqlite/index.js";

const syntheticUlid = (suffix: number): string => String(suffix).padStart(26, "0");
const PLAN_ID = syntheticUlid(1);
const SECOND_PLAN_ID = syntheticUlid(2);
const INITIAL_REVISION_ID = syntheticUlid(101);
const SECOND_INITIAL_REVISION_ID = syntheticUlid(102);
const SECOND_REVISION_ID = syntheticUlid(201);
const THIRD_REVISION_ID = syntheticUlid(301);
const SECOND_CHANGE_ID = syntheticUlid(902);
const THIRD_CHANGE_ID = syntheticUlid(903);
const FIRST_1998_MS = 903_945_600_000;
const SECOND_1998_MS = 903_949_200_000;
const THIRD_1998_MS = 903_952_800_000;
const FOURTH_1998_MS = 903_956_400_000;

function legacyPlan(planId: string, status: PlanRecord["status"] = "active"): PlanRecord {
  return {
    id: planId,
    originId: null,
    name: "Synthetic 1998 base Plan",
    primaryGoal: "Build steady endurance",
    startDateKey: 19980824,
    targetDateKey: null,
    status,
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
  planId: string,
  revisionId: string,
  revisionNumber: number,
  createdAtMs: number,
  sourceId = syntheticUlid(900 + revisionNumber),
): PlanRevisionRecord {
  return {
    id: revisionId,
    planId,
    revisionNumber,
    parentRevisionNumber: revisionNumber === 1 ? null : revisionNumber - 1,
    sourceKind: revisionNumber === 1 ? "migration" : "plan-change",
    sourceId: revisionNumber === 1 ? null : sourceId,
    snapshotJson: JSON.stringify({
      planId,
      revisionNumber,
      startDate: "1998-08-24",
    }),
    fingerprint: (revisionNumber === 1 ? "a" : revisionNumber === 2 ? "b" : "c").repeat(64),
    createdAtMs,
    deviceId: "synthetic-device-1998",
    hlcPhysicalMs: createdAtMs,
    hlcCounter: 0,
  };
}

function planChange(changeId: string, baseRevisionNumber: number, createdAtMs: number) {
  return {
    id: changeId,
    planId: PLAN_ID,
    baseRevisionNumber,
    diffJson: "{}",
    rationale: "Synthetic 1998 availability changed.",
    premisesJson: "{}",
    previewFingerprint: "d".repeat(64),
    reconciliationEffectJson: "{}",
    createdAtMs,
    deviceId: "synthetic-device-1998",
    hlcPhysicalMs: createdAtMs,
    hlcCounter: 0,
  };
}

function registration(
  planId: string,
  revisionId: string,
  status: RegisterPlanAggregateInput["status"] = "active",
): RegisterPlanAggregateInput {
  return {
    planId,
    status,
    activatedAtMs: FIRST_1998_MS,
    closedAtMs: status === "closed" ? SECOND_1998_MS : null,
    closeReason: status === "closed" ? "completed" : null,
    closeActor: status === "closed" ? PLAN_COMPLETION_ACTOR : null,
    updatedAtMs: status === "closed" ? SECOND_1998_MS : FIRST_1998_MS,
    deviceId: "synthetic-device-1998",
    hlcPhysicalMs: status === "closed" ? SECOND_1998_MS : FIRST_1998_MS,
    hlcCounter: 0,
    initialRevision: revision(planId, revisionId, 1, FIRST_1998_MS),
  };
}

describe("Plan aggregate repository", () => {
  let store: SqlStore & MigratorStore;
  let repository: ReturnType<typeof createPlanAggregateRepository>;

  beforeEach(async () => {
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
    repository = createPlanAggregateRepository(store);
  });

  afterEach(async () => {
    await store.close();
  });

  it("enforces active uniqueness and stores an immutable initial revision", async () => {
    const legacy = createPlanRepository(store);
    await legacy.replace(legacyPlan(PLAN_ID), []);
    await legacy.replace(legacyPlan(SECOND_PLAN_ID, "draft"), []);

    const created = await repository.register(registration(PLAN_ID, INITIAL_REVISION_ID));

    expect(created).toMatchObject({
      planId: PLAN_ID,
      status: "active",
      version: 1,
      currentRevisionNumber: 1,
    });
    await expect(repository.readActive()).resolves.toEqual(created);
    await expect(repository.readRevisions(PLAN_ID)).resolves.toEqual([
      revision(PLAN_ID, INITIAL_REVISION_ID, 1, FIRST_1998_MS),
    ]);
    await expect(
      repository.register({
        ...registration(PLAN_ID, INITIAL_REVISION_ID),
        updatedAtMs: FIRST_1998_MS + 1,
      }),
    ).rejects.toMatchObject({ code: "plan-conflict" });
    await expect(
      store.run("UPDATE plan_revision SET snapshot_json=? WHERE id=?", [
        '{"startDate":"1998-08-25"}',
        INITIAL_REVISION_ID,
      ]),
    ).rejects.toThrow("Plan revision is immutable");

    await expect(
      repository.register(registration(SECOND_PLAN_ID, SECOND_INITIAL_REVISION_ID)),
    ).rejects.toMatchObject({ code: "active-plan-exists" });
    await expect(repository.read(SECOND_PLAN_ID)).resolves.toBeUndefined();
    await expect(repository.readRevisions(SECOND_PLAN_ID)).resolves.toEqual([]);
  });

  it("appends with compare-and-swap and leaves no revision after a stale attempt", async () => {
    await createPlanRepository(store).replace(legacyPlan(PLAN_ID), []);
    await repository.register(registration(PLAN_ID, INITIAL_REVISION_ID));

    await expect(
      repository.appendRevision({
        planId: PLAN_ID,
        expectedVersion: 1,
        expectedRevisionNumber: 1,
        updatedAtMs: SECOND_1998_MS,
        deviceId: "synthetic-device-1998",
        hlcPhysicalMs: FIRST_1998_MS - 1,
        hlcCounter: 0,
        revision: revision(PLAN_ID, THIRD_REVISION_ID, 2, SECOND_1998_MS),
      }),
    ).rejects.toMatchObject({ code: "stale-plan" });
    await expect(
      repository.appendRevision({
        planId: PLAN_ID,
        expectedVersion: 1,
        expectedRevisionNumber: 1,
        updatedAtMs: SECOND_1998_MS,
        deviceId: "synthetic-device-1998",
        hlcPhysicalMs: THIRD_1998_MS,
        hlcCounter: 0,
        revision: revision(PLAN_ID, THIRD_REVISION_ID, 2, THIRD_1998_MS),
      }),
    ).rejects.toMatchObject({ code: "stale-plan" });

    await createPlanChangeRepository(store).createPreview(
      planChange(SECOND_CHANGE_ID, 1, SECOND_1998_MS),
    );
    await expect(
      repository.appendRevision({
        planId: PLAN_ID,
        expectedVersion: 1,
        expectedRevisionNumber: 1,
        updatedAtMs: THIRD_1998_MS,
        deviceId: "synthetic-device-1998",
        hlcPhysicalMs: THIRD_1998_MS,
        hlcCounter: 0,
        revision: revision(PLAN_ID, THIRD_REVISION_ID, 2, FIRST_1998_MS + 1, SECOND_CHANGE_ID),
      }),
    ).rejects.toMatchObject({ code: "stale-plan" });
    const secondRevision = revision(PLAN_ID, SECOND_REVISION_ID, 2, SECOND_1998_MS);
    const appended = await repository.appendRevision({
      planId: PLAN_ID,
      expectedVersion: 1,
      expectedRevisionNumber: 1,
      updatedAtMs: SECOND_1998_MS,
      deviceId: "synthetic-device-1998",
      hlcPhysicalMs: SECOND_1998_MS,
      hlcCounter: 0,
      revision: secondRevision,
    });

    expect(appended).toMatchObject({ version: 2, currentRevisionNumber: 2 });
    await expect(repository.readRevision(PLAN_ID, 2)).resolves.toEqual(secondRevision);

    await expect(
      repository.appendRevision({
        planId: PLAN_ID,
        expectedVersion: 1,
        expectedRevisionNumber: 2,
        updatedAtMs: THIRD_1998_MS,
        deviceId: "synthetic-device-1998",
        hlcPhysicalMs: THIRD_1998_MS,
        hlcCounter: 0,
        revision: revision(PLAN_ID, THIRD_REVISION_ID, 3, THIRD_1998_MS),
      }),
    ).rejects.toMatchObject({ code: "stale-plan" });

    await expect(repository.read(PLAN_ID)).resolves.toEqual(appended);
    await expect(repository.readRevision(PLAN_ID, 3)).resolves.toBeUndefined();
    await expect(repository.readRevisions(PLAN_ID)).resolves.toHaveLength(2);
  });

  it("closes by advancing lifecycle version without adding a content revision", async () => {
    await createPlanRepository(store).replace(legacyPlan(PLAN_ID), []);
    await repository.register(registration(PLAN_ID, INITIAL_REVISION_ID));
    await createPlanChangeRepository(store).createPreview(
      planChange(SECOND_CHANGE_ID, 1, SECOND_1998_MS),
    );
    await repository.appendRevision({
      planId: PLAN_ID,
      expectedVersion: 1,
      expectedRevisionNumber: 1,
      updatedAtMs: SECOND_1998_MS,
      deviceId: "synthetic-device-1998",
      hlcPhysicalMs: SECOND_1998_MS,
      hlcCounter: 0,
      revision: revision(PLAN_ID, SECOND_REVISION_ID, 2, SECOND_1998_MS),
    });
    const revisionsBeforeClose = await repository.readRevisions(PLAN_ID);
    const planChanges = createPlanChangeRepository(store);
    await planChanges.createPreview(planChange(THIRD_CHANGE_ID, 2, THIRD_1998_MS));

    await expect(
      repository.close({
        planId: PLAN_ID,
        expectedVersion: 2,
        reason: "stopped",
        actor: "synthetic-athlete",
        closedAtMs: SECOND_1998_MS,
        updatedAtMs: FOURTH_1998_MS,
        deviceId: "synthetic-device-1998",
        hlcPhysicalMs: FOURTH_1998_MS,
        hlcCounter: 0,
      }),
    ).rejects.toMatchObject({ code: "stale-plan" });

    const closed = await repository.close({
      planId: PLAN_ID,
      expectedVersion: 2,
      reason: "stopped",
      actor: "synthetic-athlete",
      closedAtMs: THIRD_1998_MS,
      updatedAtMs: FOURTH_1998_MS,
      deviceId: "synthetic-device-1998",
      hlcPhysicalMs: FOURTH_1998_MS,
      hlcCounter: 0,
    });

    expect(closed).toMatchObject({
      status: "closed",
      version: 3,
      currentRevisionNumber: 2,
      closedAtMs: THIRD_1998_MS,
      closeReason: "stopped",
      closeActor: "synthetic-athlete",
    });
    await expect(repository.readActive()).resolves.toBeUndefined();
    await expect(repository.readRevisions(PLAN_ID)).resolves.toEqual(revisionsBeforeClose);
    await expect(repository.readRevision(PLAN_ID, 3)).resolves.toBeUndefined();
    await expect(planChanges.read(THIRD_CHANGE_ID)).resolves.toMatchObject({
      status: "stale",
      version: 2,
      terminalAtMs: FOURTH_1998_MS,
    });
  });

  it("reserves completed closure for the deterministic completion actor", async () => {
    await createPlanRepository(store).replace(legacyPlan(PLAN_ID), []);
    await repository.register(registration(PLAN_ID, INITIAL_REVISION_ID));
    await expect(
      repository.close({
        planId: PLAN_ID,
        expectedVersion: 1,
        reason: "completed",
        actor: "synthetic-athlete",
        closedAtMs: SECOND_1998_MS,
        updatedAtMs: SECOND_1998_MS,
        deviceId: "synthetic-device-1998",
        hlcPhysicalMs: SECOND_1998_MS,
        hlcCounter: 0,
      }),
    ).rejects.toMatchObject({ code: "invalid-plan" });

    await expect(
      repository.close({
        planId: PLAN_ID,
        expectedVersion: 1,
        reason: "completed",
        actor: PLAN_COMPLETION_ACTOR,
        closedAtMs: SECOND_1998_MS,
        updatedAtMs: SECOND_1998_MS,
        deviceId: "synthetic-device-1998",
        hlcPhysicalMs: SECOND_1998_MS,
        hlcCounter: 0,
      }),
    ).resolves.toMatchObject({
      status: "closed",
      closeReason: "completed",
      closeActor: PLAN_COMPLETION_ACTOR,
    });
  });
});
