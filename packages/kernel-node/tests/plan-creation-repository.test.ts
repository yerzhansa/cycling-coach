import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PlanCreationStoreError,
  createAthletePlanningContextRepository,
  createPlanAggregateRepository,
  createPlanCreationRepository,
  createPlanRepository,
  runPlanningTransaction,
  type PlanCreationDraftRevisionRecord,
  type PlanCreationRepository,
  type PlanRecord,
  type RecordPlanCreationAnswerInput,
} from "@enduragent/kernel/planning";
import { runMigrations, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "../src/sqlite/index.js";

const id = (suffix: number): string => String(suffix).padStart(26, "0");
const BASE_MS = 903_945_600_000;
const DEVICE_ID = "device-1998";

function creationInput(creationId: string, createdAtMs = BASE_MS) {
  return {
    id: creationId,
    seedJson: JSON.stringify({ goalDate: "1998-10-04" }),
    createdAtMs,
    deviceId: DEVICE_ID,
    hlcPhysicalMs: createdAtMs,
    hlcCounter: 0,
  } as const;
}

function draftRevision(input: {
  readonly id: string;
  readonly creationId: string;
  readonly revisionNumber: number;
  readonly parentRevisionNumber: number | null;
  readonly inputVersion: number;
  readonly createdAtMs: number;
}): PlanCreationDraftRevisionRecord {
  const fingerprintCharacter = input.revisionNumber === 1 ? "a" : "b";
  return {
    ...input,
    inputSnapshotJson: JSON.stringify({ answerVersion: input.inputVersion }),
    inputFingerprint: fingerprintCharacter.repeat(64),
    builderId: "cycling-1998-builder",
    builderVersion: "1",
    outputSnapshotJson: JSON.stringify({ startDate: "1998-08-31" }),
    activationFingerprint: (input.revisionNumber === 1 ? "c" : "d").repeat(64),
    deviceId: DEVICE_ID,
    hlcPhysicalMs: input.createdAtMs,
    hlcCounter: 0,
  };
}

function answerInput(
  creationId: string,
  answerId: string,
  expectedVersion: number,
  atMs: number,
  overrides: Partial<RecordPlanCreationAnswerInput> = {},
): RecordPlanCreationAnswerInput {
  return {
    id: answerId,
    creationId,
    expectedVersion,
    answerKey: "weekly-availability",
    valueJson: JSON.stringify({ sessions: 4 }),
    scope: "plan-creation",
    confirmedAtMs: atMs,
    updatedAtMs: atMs,
    deviceId: DEVICE_ID,
    hlcPhysicalMs: atMs,
    hlcCounter: 0,
    preference: null,
    ...overrides,
  };
}

async function appendDraft(
  repository: PlanCreationRepository,
  input: {
    readonly creationId: string;
    readonly expectedVersion: number;
    readonly revisionNumber: number;
    readonly parentRevisionNumber: number | null;
    readonly draftId: string;
    readonly atMs: number;
  },
) {
  return repository.appendDraftRevision({
    creationId: input.creationId,
    expectedVersion: input.expectedVersion,
    updatedAtMs: input.atMs,
    deviceId: DEVICE_ID,
    hlcPhysicalMs: input.atMs,
    hlcCounter: 0,
    draft: draftRevision({
      id: input.draftId,
      creationId: input.creationId,
      revisionNumber: input.revisionNumber,
      parentRevisionNumber: input.parentRevisionNumber,
      inputVersion: input.expectedVersion,
      createdAtMs: input.atMs,
    }),
  });
}

async function registerActivePlan(
  store: SqlStore & MigratorStore,
  planId: string,
  revisionId: string,
  creationId: string,
  atMs: number,
): Promise<void> {
  const plan: PlanRecord = {
    id: planId,
    originId: null,
    name: "Synthetic 1998 Plan",
    primaryGoal: "October 1998 event",
    startDateKey: 19980824,
    targetDateKey: null,
    status: "active",
    kind: "short_race_preparation",
    totalWeeks: 4,
    weekStartDay: 1,
    structureJson: "{}",
    createdAtMs: atMs - 1,
    updatedAtMs: atMs,
    deviceId: DEVICE_ID,
    hlcPhysicalMs: atMs,
    hlcCounter: 0,
  };
  await createPlanRepository(store).replace(plan, []);
  await createPlanAggregateRepository(store).register({
    planId,
    status: "active",
    activatedAtMs: atMs,
    closedAtMs: null,
    closeReason: null,
    closeActor: null,
    updatedAtMs: atMs,
    deviceId: DEVICE_ID,
    hlcPhysicalMs: atMs,
    hlcCounter: 0,
    initialRevision: {
      id: revisionId,
      planId,
      revisionNumber: 1,
      parentRevisionNumber: null,
      sourceKind: "activation",
      sourceId: creationId,
      snapshotJson: JSON.stringify({ startDate: "1998-08-31" }),
      fingerprint: "c".repeat(64),
      createdAtMs: atMs,
      deviceId: DEVICE_ID,
      hlcPhysicalMs: atMs,
      hlcCounter: 0,
    },
  });
}

describe("Plan Creation repository", () => {
  let store: SqlStore & MigratorStore;

  beforeEach(async () => {
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
  });

  afterEach(async () => {
    await store.close();
  });

  it("returns the same unfinished Plan Creation to repeated starts", async () => {
    const firstRepository = createPlanCreationRepository(store);
    const secondRepository = createPlanCreationRepository(store);
    const first = await firstRepository.createOrReadUnfinished(creationInput(id(1)));
    const repeated = await secondRepository.createOrReadUnfinished({
      ...creationInput(id(2), BASE_MS + 1),
      seedJson: JSON.stringify({ goalDate: "1998-11-01" }),
    });

    expect(repeated).toEqual(first);
    await expect(firstRepository.readUnfinished()).resolves.toEqual(first);
    await expect(store.get("SELECT COUNT(*) AS count FROM plan_creation")).resolves.toEqual({
      count: 1,
    });
  });

  it("converges concurrent starts on one unfinished Plan Creation", async () => {
    const repository = createPlanCreationRepository(store);
    const [first, second] = await Promise.all([
      repository.createOrReadUnfinished(creationInput(id(1))),
      repository.createOrReadUnfinished(creationInput(id(2), BASE_MS + 1)),
    ]);

    expect(second).toEqual(first);
    expect([id(1), id(2)]).toContain(first.id);
    await expect(repository.readUnfinished()).resolves.toEqual(first);
    await expect(store.get("SELECT COUNT(*) AS count FROM plan_creation")).resolves.toEqual({
      count: 1,
    });
  });

  it("uses Answer CAS and invalidates the current Draft without deleting its history", async () => {
    const repository = createPlanCreationRepository(store);
    const creationId = id(1);
    const draftId = id(2);
    await repository.createOrReadUnfinished(creationInput(creationId));
    const review = await appendDraft(repository, {
      creationId,
      expectedVersion: 1,
      revisionNumber: 1,
      parentRevisionNumber: null,
      draftId,
      atMs: BASE_MS + 10,
    });
    expect(review).toMatchObject({
      status: "review",
      version: 2,
      currentDraftRevisionNumber: 1,
    });

    await expect(
      repository.recordAnswer(
        answerInput(creationId, id(99), 2, BASE_MS + 19, {
          hlcPhysicalMs: BASE_MS - 1,
        }),
      ),
    ).rejects.toEqual(new PlanCreationStoreError("stale-creation"));

    const accepted = await repository.recordAnswer(answerInput(creationId, id(3), 2, BASE_MS + 20));
    expect(accepted.creation).toMatchObject({
      status: "in-progress",
      version: 3,
      currentDraftRevisionNumber: null,
    });
    expect(accepted.answer).toMatchObject({ sequence: 1, creationVersion: 3 });
    await expect(
      repository.recordAnswer(
        answerInput(creationId, id(3), 2, BASE_MS + 20, {
          valueJson: JSON.stringify({ sessions: 5 }),
        }),
      ),
    ).rejects.toEqual(new PlanCreationStoreError("creation-conflict"));

    await expect(
      repository.recordAnswer(answerInput(creationId, id(4), 2, BASE_MS + 21)),
    ).rejects.toEqual(new PlanCreationStoreError("stale-creation"));
    await expect(repository.readAnswers(creationId)).resolves.toEqual([accepted.answer]);
    await expect(repository.readDraftRevision(creationId, 1)).resolves.toEqual(
      expect.objectContaining({ id: draftId, revisionNumber: 1 }),
    );
  });

  it("rolls back Answer and Athlete Preference when the Creation update fails", async () => {
    const creationId = id(1);
    const answerId = id(2);
    const preferenceId = id(3);
    const baseRepository = createPlanCreationRepository(store);
    await baseRepository.createOrReadUnfinished(creationInput(creationId));
    await expect(
      baseRepository.recordAnswer(
        answerInput(creationId, answerId, 1, BASE_MS + 10, {
          scope: "athlete-preference",
          preference: {
            id: preferenceId,
            preferenceKey: "preferred-training-days",
            valueJson: JSON.stringify(["tue", "thu", "sat"]),
            sourceAnswerId: answerId,
            createdAtMs: BASE_MS + 10,
            deviceId: DEVICE_ID,
            hlcPhysicalMs: BASE_MS + 9,
            hlcCounter: 0,
          },
        }),
      ),
    ).rejects.toEqual(new PlanCreationStoreError("invalid-creation"));
    const failingStore: SqlStore & Pick<MigratorStore, "transaction"> = {
      exec: store.exec.bind(store),
      run: async (sql, params) => {
        if (sql.startsWith("UPDATE plan_creation SET")) {
          throw new Error("forced Plan Creation update failure");
        }
        await store.run(sql, params);
      },
      get: store.get.bind(store),
      all: store.all.bind(store),
      close: store.close.bind(store),
      transaction: store.transaction.bind(store),
    };
    const repository = createPlanCreationRepository(failingStore);

    await expect(
      repository.recordAnswer(
        answerInput(creationId, answerId, 1, BASE_MS + 10, {
          scope: "athlete-preference",
          preference: {
            id: preferenceId,
            preferenceKey: "preferred-training-days",
            valueJson: JSON.stringify(["tue", "thu", "sat"]),
            sourceAnswerId: answerId,
            createdAtMs: BASE_MS + 10,
            deviceId: DEVICE_ID,
            hlcPhysicalMs: BASE_MS + 10,
            hlcCounter: 0,
          },
        }),
      ),
    ).rejects.toThrow("forced Plan Creation update failure");

    await expect(baseRepository.readAnswers(creationId)).resolves.toEqual([]);
    await expect(
      createAthletePlanningContextRepository(store).readPreference(preferenceId),
    ).resolves.toBeUndefined();
    await expect(baseRepository.read(creationId)).resolves.toMatchObject({
      status: "in-progress",
      version: 1,
      currentDraftRevisionNumber: null,
    });
  });

  it("keeps Draft revisions immutable and enforces a linear revision chain", async () => {
    const repository = createPlanCreationRepository(store);
    const creationId = id(1);
    const firstDraftId = id(2);
    const secondDraftId = id(3);
    await repository.createOrReadUnfinished(creationInput(creationId));

    await expect(
      appendDraft(repository, {
        creationId,
        expectedVersion: 1,
        revisionNumber: 2,
        parentRevisionNumber: 1,
        draftId: secondDraftId,
        atMs: BASE_MS + 9,
      }),
    ).rejects.toEqual(new PlanCreationStoreError("stale-creation"));

    await appendDraft(repository, {
      creationId,
      expectedVersion: 1,
      revisionNumber: 1,
      parentRevisionNumber: null,
      draftId: firstDraftId,
      atMs: BASE_MS + 10,
    });
    await repository.recordAnswer(answerInput(creationId, id(4), 2, BASE_MS + 20));

    await expect(
      appendDraft(repository, {
        creationId,
        expectedVersion: 3,
        revisionNumber: 2,
        parentRevisionNumber: null,
        draftId: secondDraftId,
        atMs: BASE_MS + 30,
      }),
    ).rejects.toEqual(new PlanCreationStoreError("invalid-creation"));

    await appendDraft(repository, {
      creationId,
      expectedVersion: 3,
      revisionNumber: 2,
      parentRevisionNumber: 1,
      draftId: secondDraftId,
      atMs: BASE_MS + 30,
    });
    await expect(repository.readDraftRevisions(creationId)).resolves.toEqual([
      expect.objectContaining({
        id: firstDraftId,
        revisionNumber: 1,
        parentRevisionNumber: null,
        inputVersion: 1,
      }),
      expect.objectContaining({
        id: secondDraftId,
        revisionNumber: 2,
        parentRevisionNumber: 1,
        inputVersion: 3,
      }),
    ]);
    await expect(
      store.run("UPDATE plan_creation_draft_revision SET output_snapshot_json='{}' WHERE id=?", [
        firstDraftId,
      ]),
    ).rejects.toThrow("Plan Creation Draft revision is immutable");
    await expect(
      store.run("DELETE FROM plan_creation_draft_revision WHERE id=?", [secondDraftId]),
    ).rejects.toThrow("Plan Creation Draft revision is immutable");
  });

  it("requires review before activation and preserves terminal discard and activation states", async () => {
    const repository = createPlanCreationRepository(store);
    const discardedCreationId = id(1);
    const activatedCreationId = id(2);
    const planId = id(90);
    await repository.createOrReadUnfinished(creationInput(discardedCreationId));
    await expect(
      repository.transition({
        creationId: discardedCreationId,
        expectedVersion: 1,
        target: "activated",
        activatedPlanId: planId,
        terminalAtMs: BASE_MS + 10,
        updatedAtMs: BASE_MS + 10,
        deviceId: DEVICE_ID,
        hlcPhysicalMs: BASE_MS + 10,
        hlcCounter: 0,
      }),
    ).rejects.toEqual(new PlanCreationStoreError("stale-creation"));
    await expect(
      repository.transition({
        creationId: discardedCreationId,
        expectedVersion: 1,
        target: "discarded",
        activatedPlanId: planId,
        terminalAtMs: BASE_MS + 10,
        updatedAtMs: BASE_MS + 10,
        deviceId: DEVICE_ID,
        hlcPhysicalMs: BASE_MS + 10,
        hlcCounter: 0,
      }),
    ).rejects.toEqual(new PlanCreationStoreError("invalid-creation"));

    const discarded = await repository.transition({
      creationId: discardedCreationId,
      expectedVersion: 1,
      target: "discarded",
      activatedPlanId: null,
      terminalAtMs: BASE_MS + 10,
      updatedAtMs: BASE_MS + 10,
      deviceId: DEVICE_ID,
      hlcPhysicalMs: BASE_MS + 10,
      hlcCounter: 0,
    });
    expect(discarded).toMatchObject({ status: "discarded", version: 2, activatedPlanId: null });
    await expect(
      repository.recordAnswer(answerInput(discardedCreationId, id(3), 2, BASE_MS + 11)),
    ).rejects.toEqual(new PlanCreationStoreError("creation-not-unfinished"));

    await repository.createOrReadUnfinished(creationInput(activatedCreationId, BASE_MS + 20));
    await appendDraft(repository, {
      creationId: activatedCreationId,
      expectedVersion: 1,
      revisionNumber: 1,
      parentRevisionNumber: null,
      draftId: id(4),
      atMs: BASE_MS + 30,
    });
    await registerActivePlan(store, planId, id(91), activatedCreationId, BASE_MS + 35);
    await expect(
      repository.transition({
        creationId: activatedCreationId,
        expectedVersion: 2,
        target: "activated",
        activatedPlanId: id(92),
        terminalAtMs: BASE_MS + 40,
        updatedAtMs: BASE_MS + 40,
        deviceId: DEVICE_ID,
        hlcPhysicalMs: BASE_MS + 40,
        hlcCounter: 0,
      }),
    ).rejects.toEqual(new PlanCreationStoreError("missing-activated-plan"));

    const activated = await repository.transition({
      creationId: activatedCreationId,
      expectedVersion: 2,
      target: "activated",
      activatedPlanId: planId,
      terminalAtMs: BASE_MS + 40,
      updatedAtMs: BASE_MS + 40,
      deviceId: DEVICE_ID,
      hlcPhysicalMs: BASE_MS + 40,
      hlcCounter: 0,
    });
    expect(activated).toMatchObject({
      status: "activated",
      version: 3,
      currentDraftRevisionNumber: 1,
      activatedPlanId: planId,
    });
    await expect(
      repository.transition({
        creationId: activatedCreationId,
        expectedVersion: 2,
        target: "activated",
        activatedPlanId: id(92),
        terminalAtMs: BASE_MS + 40,
        updatedAtMs: BASE_MS + 40,
        deviceId: DEVICE_ID,
        hlcPhysicalMs: BASE_MS + 40,
        hlcCounter: 0,
      }),
    ).rejects.toEqual(new PlanCreationStoreError("creation-conflict"));
    await expect(repository.readUnfinished()).resolves.toBeUndefined();
    await expect(
      repository.transition({
        creationId: activatedCreationId,
        expectedVersion: 3,
        target: "discarded",
        activatedPlanId: null,
        terminalAtMs: BASE_MS + 50,
        updatedAtMs: BASE_MS + 50,
        deviceId: DEVICE_ID,
        hlcPhysicalMs: BASE_MS + 50,
        hlcCounter: 0,
      }),
    ).rejects.toEqual(new PlanCreationStoreError("stale-creation"));
  });

  it("rolls back Plan registration and Creation activation together", async () => {
    const creationId = id(10);
    const planId = id(90);
    const revisionId = id(91);
    const repository = createPlanCreationRepository(store);
    const aggregate = createPlanAggregateRepository(store);
    await repository.createOrReadUnfinished(creationInput(creationId));
    await appendDraft(repository, {
      creationId,
      expectedVersion: 1,
      revisionNumber: 1,
      parentRevisionNumber: null,
      draftId: id(11),
      atMs: BASE_MS + 10,
    });
    await createPlanRepository(store).replace(
      {
        id: planId,
        originId: null,
        name: "Synthetic 1998 activated Plan",
        primaryGoal: "October 1998 event",
        startDateKey: 19980831,
        targetDateKey: null,
        status: "active",
        kind: "short_race_preparation",
        totalWeeks: 4,
        weekStartDay: 1,
        structureJson: "{}",
        createdAtMs: BASE_MS + 19,
        updatedAtMs: BASE_MS + 20,
        deviceId: DEVICE_ID,
        hlcPhysicalMs: BASE_MS + 20,
        hlcCounter: 0,
      },
      [],
    );
    const registration = {
      planId,
      status: "active" as const,
      activatedAtMs: BASE_MS + 20,
      closedAtMs: null,
      closeReason: null,
      closeActor: null,
      updatedAtMs: BASE_MS + 20,
      deviceId: DEVICE_ID,
      hlcPhysicalMs: BASE_MS + 20,
      hlcCounter: 0,
      initialRevision: {
        id: revisionId,
        planId,
        revisionNumber: 1,
        parentRevisionNumber: null,
        sourceKind: "activation" as const,
        sourceId: creationId,
        snapshotJson: JSON.stringify({ startDate: "1998-08-31" }),
        fingerprint: "c".repeat(64),
        createdAtMs: BASE_MS + 20,
        deviceId: DEVICE_ID,
        hlcPhysicalMs: BASE_MS + 20,
        hlcCounter: 0,
      },
    };
    const transition = {
      creationId,
      expectedVersion: 2,
      target: "activated" as const,
      activatedPlanId: planId,
      terminalAtMs: BASE_MS + 30,
      updatedAtMs: BASE_MS + 30,
      deviceId: DEVICE_ID,
      hlcPhysicalMs: BASE_MS + 30,
      hlcCounter: 0,
    };

    await expect(
      aggregate.register({
        ...registration,
        activatedAtMs: BASE_MS + 9,
        initialRevision: {
          ...registration.initialRevision,
          createdAtMs: BASE_MS + 9,
          hlcPhysicalMs: BASE_MS + 9,
        },
      }),
    ).rejects.toMatchObject({ code: "invalid-plan" });

    await expect(
      runPlanningTransaction(store, async (transaction) => {
        await transaction.plans.register(registration);
        await transaction.planCreations.transition(transition);
        throw new Error("synthetic activation failure");
      }),
    ).rejects.toThrow("synthetic activation failure");
    await expect(aggregate.read(planId)).resolves.toBeUndefined();
    await expect(aggregate.readRevision(planId, 1)).resolves.toBeUndefined();
    await expect(repository.read(creationId)).resolves.toMatchObject({
      status: "review",
      version: 2,
    });

    const activated = await runPlanningTransaction(store, async (transaction) => {
      await transaction.plans.register(registration);
      return transaction.planCreations.transition(transition);
    });
    expect(activated).toMatchObject({
      status: "activated",
      version: 3,
      activatedPlanId: planId,
    });
    await expect(aggregate.read(planId)).resolves.toMatchObject({
      status: "active",
      currentRevisionNumber: 1,
    });
  });
});
