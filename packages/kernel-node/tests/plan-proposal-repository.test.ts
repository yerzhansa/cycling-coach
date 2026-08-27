import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPlanAdaptationLedgerRepository,
  createPlanProposalRepository,
  createPlanReconciliationRepository,
  createPlanRepository,
  createPlanningRequestRepository,
  encodePlanAdaptationWorkoutSnapshot,
  planAdaptationWorkoutSnapshot,
  type PlanAdaptationLedgerRecord,
  PlanProposalValidationError,
  type PlanProposalPremiseRecord,
  type PlanProposalRecord,
  type PlanRecord,
  type PlanWorkoutRecord,
} from "@enduragent/kernel/planning";
import { runMigrations, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { createNodeCrypto } from "../src/ingest/import-files.js";
import { openSqliteStorage } from "../src/sqlite/index.js";

const id = (suffix: number): string => String(suffix).padStart(26, "0");
const PLAN_ID = id(1);
const WORKOUT_ID = id(2);

const plan: PlanRecord = {
  id: PLAN_ID,
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

const workout: PlanWorkoutRecord = {
  id: WORKOUT_ID,
  planId: PLAN_ID,
  dateKey: 20260830,
  sport: "cycling",
  name: "Endurance",
  durationS: 5_400,
  structureJson: "{}",
  origin: "coach",
  deviceId: "device-1",
  hlcPhysicalMs: 10,
  hlcCounter: 0,
};

function proposal(
  proposalId: string,
  overrides: Partial<PlanProposalRecord> = {},
): PlanProposalRecord {
  return {
    id: proposalId,
    planId: PLAN_ID,
    parentProposalId: null,
    revision: 1,
    status: "proposed",
    title: "Sunday recovery",
    rationale: "Saturday fatigue is above normal.",
    confidence: "High",
    mutationJson: '{"changes":[],"schemaVersion":1,"weekLoad":null}',
    baseSnapshotJson: '{"planUpdatedAtMs":10,"schemaVersion":1,"workouts":[]}',
    refusalReason: null,
    createdAtMs: 20,
    updatedAtMs: 20,
    resolvedAtMs: null,
    deviceId: "device-1",
    hlcPhysicalMs: 20,
    hlcCounter: 0,
    ...overrides,
  };
}

function premise(proposalId: string, premiseId: string): PlanProposalPremiseRecord {
  return {
    id: premiseId,
    proposalId,
    sourceType: "activity",
    sourceId: "ride-21-aug",
    sourceLabel: "Saturday ride · 21 Aug",
    sourceDateKey: 20260821,
    confidence: "High",
    snapshotJson: '{"loadAboveNormal":12}',
    createdAtMs: 20,
    deviceId: "device-1",
    hlcPhysicalMs: 20,
    hlcCounter: 0,
  };
}

function ledger(
  ledgerId: string,
  proposalId: string,
  before: PlanWorkoutRecord,
  after: PlanWorkoutRecord,
  occurredAtMs: number,
): PlanAdaptationLedgerRecord {
  return {
    id: ledgerId,
    planId: PLAN_ID,
    targetWorkoutId: WORKOUT_ID,
    operation: "update",
    kind: "proposal-applied",
    sourceId: proposalId,
    reversalOfId: null,
    label: "Sunday recovery applied",
    beforeJson: encodePlanAdaptationWorkoutSnapshot(planAdaptationWorkoutSnapshot(before)),
    afterJson: encodePlanAdaptationWorkoutSnapshot(planAdaptationWorkoutSnapshot(after)),
    weekLoadBefore: 420,
    weekLoadAfter: 360,
    occurredAtMs,
    deviceId: "device-1",
    hlcPhysicalMs: occurredAtMs,
    hlcCounter: 0,
  };
}

async function linkedRequest(
  store: SqlStore & MigratorStore,
  requestId: string,
  proposalId: string,
  updatedAtMs = 30,
) {
  const requests = createPlanningRequestRepository(store, createNodeCrypto());
  const created = await requests.createOrGet({
    payload: {
      requestId,
      kind: "workout_review",
      intent: "Add Tempo 3 × 12 to the active Plan.",
      source: {
        chatId: "chat-1",
        messageId: "message-1",
        attachmentId: "attachment-1",
      },
      sourceSnapshot: {
        capturedAt: "1998-08-24T08:00:00.000Z",
        attachment: {
          attachmentId: "attachment-1",
          displayName: "tempo-3x12.mrc",
          extension: "mrc",
        },
        selectedWorkout: {
          setId: "set-1",
          workoutId: "workout-1",
          workout: {
            name: "Tempo 3 × 12",
            sport: "cycling",
            durationSeconds: 3_840,
          },
        },
      },
      requestedDate: "2026-08-30",
    },
    target: "active_plan",
    createdAtMs: 20,
    deviceId: "device-1",
    hlcPhysicalMs: 20,
    hlcCounter: 0,
  });
  return {
    requests,
    record: await requests.reviseOpen({
      requestId,
      expectedRevision: created.request.revision,
      planConversationId: null,
      proposalId,
      attention: "needs_review",
      resolvedDateKey: 20260830,
      updatedAtMs,
      deviceId: "device-1",
      hlcPhysicalMs: updatedAtMs,
      hlcCounter: 0,
    }),
  };
}

describe("Plan proposal repository", () => {
  let store: SqlStore & MigratorStore;

  beforeEach(async () => {
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
    await createPlanRepository(store).replace(plan, [workout]);
  });

  afterEach(async () => {
    await store.close();
  });

  it("stores several independent proposals and premise snapshots by value", async () => {
    const repository = createPlanProposalRepository(store);
    await repository.save(proposal(id(3)), [premise(id(3), id(4))]);
    await repository.save(proposal(id(5), { createdAtMs: 21, updatedAtMs: 21 }), [
      { ...premise(id(5), id(6)), createdAtMs: 21, hlcPhysicalMs: 21 },
    ]);
    await expect(repository.readOpenForPlan(PLAN_ID)).resolves.toHaveLength(2);
    await expect(repository.readPremises(id(3))).resolves.toEqual([
      expect.objectContaining({ snapshotJson: '{"loadAboveNormal":12}' }),
    ]);
  });

  it("rejects impossible premise dates in validation and at the schema boundary", async () => {
    const repository = createPlanProposalRepository(store);
    await expect(
      repository.save(proposal(id(3)), [{ ...premise(id(3), id(4)), sourceDateKey: 20260230 }]),
    ).rejects.toEqual(new PlanProposalValidationError("invalid-premise"));

    await repository.save(proposal(id(3)), [premise(id(3), id(4))]);
    await expect(
      store.run(
        `INSERT INTO plan_proposal_premise (
          id,proposal_id,source_type,source_id,source_label,source_date_key,
          confidence,snapshot_json,created_at_ms,device_id,hlc_physical_ms,hlc_counter
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id(5),
          id(3),
          "activity",
          "invalid-date",
          "Impossible date",
          20260230,
          "High",
          "{}",
          21,
          "device-1",
          21,
          0,
        ],
      ),
    ).rejects.toThrow();
  });

  it("supersedes only the revised proposal and preserves the original premises", async () => {
    const repository = createPlanProposalRepository(store);
    await repository.save(proposal(id(3)), [premise(id(3), id(4))]);
    await repository.save(
      proposal(id(5), {
        parentProposalId: id(3),
        revision: 2,
        title: "Sunday recovery · revised",
        createdAtMs: 30,
        updatedAtMs: 30,
        hlcPhysicalMs: 30,
      }),
      [{ ...premise(id(5), id(6)), createdAtMs: 30, hlcPhysicalMs: 30 }],
    );
    await expect(repository.read(id(3))).resolves.toMatchObject({ status: "superseded" });
    await expect(repository.readOpenForPlan(PLAN_ID)).resolves.toEqual([
      expect.objectContaining({ id: id(5), revision: 2 }),
    ]);
    await expect(repository.readPremises(id(3))).resolves.toHaveLength(1);
    await store.run("DELETE FROM plan WHERE id=?", [PLAN_ID]);
    await expect(repository.read(id(3))).resolves.toBeUndefined();
    await expect(repository.read(id(5))).resolves.toBeUndefined();
  });

  it("applies the reviewed workout and proposal in one stale-base-guarded transaction", async () => {
    const proposals = createPlanProposalRepository(store);
    const plans = createPlanRepository(store);
    const reconciliations = createPlanReconciliationRepository(store);
    const history = createPlanAdaptationLedgerRepository(store);
    const nextWorkout = {
      ...workout,
      name: "Recovery",
      durationS: 1_800,
      hlcPhysicalMs: 40,
    };
    await proposals.save(proposal(id(3)), [premise(id(3), id(4))]);
    await reconciliations.createOrGetJob({
      id: id(7),
      planId: PLAN_ID,
      kind: "mirror",
      windowStartDateKey: 20260826,
      windowEndDateKey: 20260901,
      createdAtMs: 20,
    });
    await reconciliations.prepareItem({
      id: id(8),
      jobId: id(7),
      planWorkoutId: WORKOUT_ID,
      operation: "create",
      dateKey: workout.dateKey,
      externalId: `cycling-coach:plan:${PLAN_ID}:${WORKOUT_ID}`,
      expectedJson: "{}",
      createdAtMs: 20,
    });
    await reconciliations.beginAttempt(id(7), 21);
    await reconciliations.verifyItem(id(8), 42, 22);
    await reconciliations.verifyJob(id(7), 23);
    await expect(
      proposals.apply({
        id: id(3),
        expectedPlanUpdatedAtMs: 10,
        expectedPlanHlcPhysicalMs: 10,
        expectedPlanHlcCounter: 0,
        expectedWorkouts: [workout],
        mirrorJob: {
          id: id(9),
          windowStartDateKey: 20260826,
          windowEndDateKey: 20260901,
          createdAtMs: 40,
        },
        plan: { ...plan, updatedAtMs: 40, hlcPhysicalMs: 40 },
        workouts: [nextWorkout],
        ledger: ledger(id(10), id(3), workout, nextWorkout, 40),
        resolvedAtMs: 40,
        deviceId: "device-1",
        hlcPhysicalMs: 40,
        hlcCounter: 0,
      }),
    ).resolves.toMatchObject({ status: "applied" });
    await expect(plans.readWorkouts(PLAN_ID)).resolves.toEqual([
      expect.objectContaining({ name: "Recovery", durationS: 1_800 }),
    ]);
    await expect(history.readForPlan(PLAN_ID)).resolves.toEqual([
      expect.objectContaining({ id: id(10), sourceId: id(3), kind: "proposal-applied" }),
    ]);
    await expect(reconciliations.readLatestJob(PLAN_ID, "mirror")).resolves.toMatchObject({
      id: id(7),
      status: "pending",
      attemptCount: 0,
      failureCount: 0,
    });
    await expect(reconciliations.readItems(id(7))).resolves.toEqual([]);
    await expect(
      proposals.apply({
        id: id(3),
        expectedPlanUpdatedAtMs: 10,
        expectedPlanHlcPhysicalMs: 10,
        expectedPlanHlcCounter: 0,
        expectedWorkouts: [workout],
        mirrorJob: {
          id: id(9),
          windowStartDateKey: 20260826,
          windowEndDateKey: 20260901,
          createdAtMs: 50,
        },
        plan: { ...plan, updatedAtMs: 50, hlcPhysicalMs: 50 },
        workouts: [{ ...nextWorkout, hlcPhysicalMs: 50 }],
        ledger: ledger(id(11), id(3), workout, { ...nextWorkout, hlcPhysicalMs: 50 }, 50),
        resolvedAtMs: 50,
        deviceId: "device-1",
        hlcPhysicalMs: 50,
        hlcCounter: 0,
      }),
    ).rejects.toBeInstanceOf(PlanProposalValidationError);
  });

  it("atomically adds a reviewed Workout and preserves an immutable addition ledger", async () => {
    const proposals = createPlanProposalRepository(store);
    const plans = createPlanRepository(store);
    const history = createPlanAdaptationLedgerRepository(store);
    const proposalId = id(12);
    const addedWorkout: PlanWorkoutRecord = {
      id: id(13),
      planId: PLAN_ID,
      dateKey: 20260831,
      sport: "cycling",
      name: "Tempo 3 × 12",
      durationS: 3_840,
      structureJson: JSON.stringify({ intervals: [{ repetitions: 3, durationS: 720 }] }),
      origin: "coach",
      deviceId: "device-1",
      hlcPhysicalMs: 40,
      hlcCounter: 0,
    };
    await proposals.save(proposal(proposalId), [premise(proposalId, id(14))]);

    await expect(
      proposals.apply({
        id: proposalId,
        expectedPlanUpdatedAtMs: 10,
        expectedPlanHlcPhysicalMs: 10,
        expectedPlanHlcCounter: 0,
        expectedWorkouts: [],
        mirrorJob: {
          id: id(15),
          windowStartDateKey: 20260826,
          windowEndDateKey: 20260901,
          createdAtMs: 40,
        },
        plan: { ...plan, updatedAtMs: 40, hlcPhysicalMs: 40 },
        workouts: [addedWorkout],
        ledger: {
          id: id(16),
          planId: PLAN_ID,
          targetWorkoutId: addedWorkout.id,
          operation: "add",
          kind: "proposal-applied",
          sourceId: proposalId,
          reversalOfId: null,
          label: "Tempo 3 × 12 added",
          beforeJson: null,
          afterJson: encodePlanAdaptationWorkoutSnapshot(
            planAdaptationWorkoutSnapshot(addedWorkout),
          ),
          weekLoadBefore: 420,
          weekLoadAfter: 480,
          occurredAtMs: 40,
          deviceId: "device-1",
          hlcPhysicalMs: 40,
          hlcCounter: 0,
        },
        resolvedAtMs: 40,
        deviceId: "device-1",
        hlcPhysicalMs: 40,
        hlcCounter: 0,
      }),
    ).resolves.toMatchObject({ status: "applied" });
    await expect(plans.readWorkouts(PLAN_ID)).resolves.toEqual([workout, addedWorkout]);
    await expect(history.readForPlan(PLAN_ID)).resolves.toEqual([
      expect.objectContaining({
        operation: "add",
        targetWorkoutId: addedWorkout.id,
        beforeJson: null,
      }),
    ]);
  });

  it("rolls back Plan application when the linked request cannot commit its terminal result", async () => {
    const proposals = createPlanProposalRepository(store);
    const plans = createPlanRepository(store);
    const history = createPlanAdaptationLedgerRepository(store);
    const proposalId = id(17);
    const ledgerId = id(18);
    const requestId = id(19);
    const nextWorkout = {
      ...workout,
      name: "Recovery",
      durationS: 1_800,
      hlcPhysicalMs: 40,
    };
    await proposals.save(proposal(proposalId), [premise(proposalId, id(20))]);
    const { requests, record } = await linkedRequest(store, requestId, proposalId);
    const requestCompletion = {
      requestId,
      expectedRevision: record.request.revision,
      expectedProposalId: proposalId,
      result: {
        kind: "applied" as const,
        resultId: id(21),
        completedAtMs: 40,
        title: "Added to Plan",
        detail: "Tempo 3 × 12 is scheduled for 2026-08-30.",
        workoutRef: { setId: "set-1", workoutId: "workout-1" },
        planRevisionId: ledgerId,
      },
      resolvedDateKey: 20260830,
      updatedAtMs: 40,
      deviceId: "device-1",
      hlcPhysicalMs: 40,
      hlcCounter: 0,
    };
    const application = {
      id: proposalId,
      expectedPlanUpdatedAtMs: 10,
      expectedPlanHlcPhysicalMs: 10,
      expectedPlanHlcCounter: 0,
      expectedWorkouts: [workout],
      mirrorJob: {
        id: id(22),
        windowStartDateKey: 20260826,
        windowEndDateKey: 20260901,
        createdAtMs: 40,
      },
      plan: { ...plan, updatedAtMs: 40, hlcPhysicalMs: 40 },
      workouts: [nextWorkout],
      ledger: ledger(ledgerId, proposalId, workout, nextWorkout, 40),
      resolvedAtMs: 40,
      deviceId: "device-1",
      hlcPhysicalMs: 40,
      hlcCounter: 0,
    };

    await expect(
      proposals.apply({
        ...application,
        requestCompletion: {
          ...requestCompletion,
          expectedRevision: requestCompletion.expectedRevision + 1,
        },
      }),
    ).rejects.toMatchObject({ code: "stale-revision" });
    await expect(plans.readWorkouts(PLAN_ID)).resolves.toEqual([workout]);
    await expect(proposals.read(proposalId)).resolves.toMatchObject({ status: "proposed" });
    await expect(requests.read(requestId)).resolves.toMatchObject({
      request: { lifecycle: "open", terminalResult: null },
    });
    await expect(history.readForPlan(PLAN_ID)).resolves.toEqual([]);

    await expect(proposals.apply({ ...application, requestCompletion })).resolves.toMatchObject({
      status: "applied",
    });
    await expect(plans.readWorkouts(PLAN_ID)).resolves.toEqual([
      expect.objectContaining({ name: "Recovery" }),
    ]);
    await expect(requests.read(requestId)).resolves.toMatchObject({
      request: {
        lifecycle: "applied",
        attention: "none",
        terminalResult: { kind: "applied", planRevisionId: ledgerId },
      },
    });
  });

  it("moves a linked request to a revised Proposal in the same transaction", async () => {
    const proposals = createPlanProposalRepository(store);
    const initialId = id(23);
    const revisedId = id(24);
    const requestId = id(25);
    await proposals.save(proposal(initialId), [premise(initialId, id(26))]);
    const { requests, record } = await linkedRequest(store, requestId, initialId);
    await proposals.save(
      proposal(revisedId, {
        parentProposalId: initialId,
        revision: 2,
        createdAtMs: 40,
        updatedAtMs: 40,
        hlcPhysicalMs: 40,
      }),
      [{ ...premise(revisedId, id(27)), createdAtMs: 40, hlcPhysicalMs: 40 }],
      {
        requestId,
        expectedRevision: record.request.revision,
        previousProposalId: initialId,
        proposalId: revisedId,
        attention: "stale_base",
        resolvedDateKey: 20260831,
        updatedAtMs: 40,
        deviceId: "device-1",
        hlcPhysicalMs: 40,
        hlcCounter: 0,
      },
    );
    await expect(proposals.read(initialId)).resolves.toMatchObject({ status: "superseded" });
    await expect(requests.read(requestId)).resolves.toMatchObject({
      request: {
        proposalId: revisedId,
        attention: "stale_base",
        resolvedDateKey: 20260831,
        revision: record.request.revision + 1,
      },
    });
  });

  it("rejects a Proposal and completes its linked request atomically", async () => {
    const proposals = createPlanProposalRepository(store);
    const proposalId = id(28);
    const requestId = id(29);
    await proposals.save(proposal(proposalId), [premise(proposalId, id(30))]);
    const { requests, record } = await linkedRequest(store, requestId, proposalId);
    await proposals.resolve({
      id: proposalId,
      status: "rejected",
      resolvedAtMs: 40,
      deviceId: "device-1",
      hlcPhysicalMs: 40,
      hlcCounter: 0,
      requestCompletion: {
        requestId,
        expectedRevision: record.request.revision,
        expectedProposalId: proposalId,
        result: {
          kind: "rejected",
          resultId: id(31),
          completedAtMs: 40,
          title: "Proposal rejected",
          detail: "Tempo 3 × 12 was not applied; the active Plan remains unchanged.",
          workoutRef: { setId: "set-1", workoutId: "workout-1" },
          planRevisionId: null,
        },
        resolvedDateKey: 20260830,
        updatedAtMs: 40,
        deviceId: "device-1",
        hlcPhysicalMs: 40,
        hlcCounter: 0,
      },
    });
    await expect(proposals.read(proposalId)).resolves.toMatchObject({ status: "rejected" });
    await expect(requests.read(requestId)).resolves.toMatchObject({
      request: { lifecycle: "rejected", terminalResult: { kind: "rejected" } },
    });
    await expect(createPlanRepository(store).readWorkouts(PLAN_ID)).resolves.toEqual([workout]);
  });

  it("rejects apply when a workout changed without advancing the Plan timestamp", async () => {
    const proposals = createPlanProposalRepository(store);
    const plans = createPlanRepository(store);
    await proposals.save(proposal(id(3)), [premise(id(3), id(4))]);
    await store.run(`UPDATE plan_workout SET name=?, hlc_physical_ms=? WHERE id=? AND plan_id=?`, [
      "Athlete edit",
      30,
      WORKOUT_ID,
      PLAN_ID,
    ]);
    const nextWorkout = {
      ...workout,
      name: "Recovery",
      durationS: 1_800,
      hlcPhysicalMs: 40,
    };

    await expect(
      proposals.apply({
        id: id(3),
        expectedPlanUpdatedAtMs: 10,
        expectedPlanHlcPhysicalMs: 10,
        expectedPlanHlcCounter: 0,
        expectedWorkouts: [workout],
        mirrorJob: {
          id: id(9),
          windowStartDateKey: 20260826,
          windowEndDateKey: 20260901,
          createdAtMs: 40,
        },
        plan: { ...plan, updatedAtMs: 40, hlcPhysicalMs: 40 },
        workouts: [nextWorkout],
        ledger: ledger(id(10), id(3), workout, nextWorkout, 40),
        resolvedAtMs: 40,
        deviceId: "device-1",
        hlcPhysicalMs: 40,
        hlcCounter: 0,
      }),
    ).rejects.toMatchObject({ code: "stale-base" });
    await expect(plans.readWorkouts(PLAN_ID)).resolves.toEqual([
      expect.objectContaining({ name: "Athlete edit", hlcPhysicalMs: 30 }),
    ]);
    await expect(proposals.read(id(3))).resolves.toMatchObject({ status: "proposed" });
  });

  it("rejects apply when the Plan HLC advances within the same millisecond", async () => {
    const proposals = createPlanProposalRepository(store);
    await proposals.save(proposal(id(3)), [premise(id(3), id(4))]);
    await store.run("UPDATE plan SET hlc_counter=? WHERE id=?", [1, PLAN_ID]);
    const nextWorkout = {
      ...workout,
      name: "Recovery",
      durationS: 1_800,
      hlcPhysicalMs: 40,
    };

    await expect(
      proposals.apply({
        id: id(3),
        expectedPlanUpdatedAtMs: 10,
        expectedPlanHlcPhysicalMs: 10,
        expectedPlanHlcCounter: 0,
        expectedWorkouts: [workout],
        mirrorJob: {
          id: id(9),
          windowStartDateKey: 20260826,
          windowEndDateKey: 20260901,
          createdAtMs: 40,
        },
        plan: { ...plan, updatedAtMs: 40, hlcPhysicalMs: 40 },
        workouts: [nextWorkout],
        ledger: ledger(id(10), id(3), workout, nextWorkout, 40),
        resolvedAtMs: 40,
        deviceId: "device-1",
        hlcPhysicalMs: 40,
        hlcCounter: 0,
      }),
    ).rejects.toMatchObject({ code: "stale-base" });
    await expect(proposals.read(id(3))).resolves.toMatchObject({ status: "proposed" });
  });
});
