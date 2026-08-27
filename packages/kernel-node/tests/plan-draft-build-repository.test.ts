import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPlanConversationRepository,
  createPlanDraftBuildRepository,
  createPlanRepository,
  type PlanConversationRecord,
  type PlanDraftRevisionRecord,
  type PlanRecord,
  type PlanWorkoutRecord,
} from "@enduragent/kernel/planning";
import { runMigrations, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";

const CONVERSATION_ID = "00000000000000000000000001";
const PLAN_ID = "00000000000000000000000002";
const REVISION_ID = "00000000000000000000000003";
const NEXT_REVISION_ID = "00000000000000000000000004";
const CHECKPOINT_ID = "00000000000000000000000005";
const WORKOUT_ID = "00000000000000000000000006";

function plan(primaryGoal = "Finish comfortably", updatedAtMs = 100): PlanRecord {
  return {
    id: PLAN_ID,
    originId: null,
    name: "Goal Event Plan",
    primaryGoal,
    startDateKey: 19980713,
    targetDateKey: 19981004,
    status: "draft",
    kind: "full_plan",
    totalWeeks: 12,
    weekStartDay: 1,
    structureJson: "{}",
    createdAtMs: 100,
    updatedAtMs,
    deviceId: "device-1",
    hlcPhysicalMs: updatedAtMs,
    hlcCounter: 0,
  };
}

function workout(name = "Endurance", counter = 0): PlanWorkoutRecord {
  return {
    id: WORKOUT_ID,
    planId: PLAN_ID,
    dateKey: 19980714,
    sport: "cycling",
    name,
    durationS: 3_600,
    structureJson: "{}",
    origin: "coach",
    deviceId: "device-1",
    hlcPhysicalMs: 100 + counter,
    hlcCounter: counter,
  };
}

function conversation(updatedAtMs = 100): PlanConversationRecord {
  return {
    id: CONVERSATION_ID,
    planId: PLAN_ID,
    replacesPlanId: null,
    courseChoiceStatus: "omitted",
    raceCourseJson: null,
    status: "open",
    endedAtMs: null,
    createdAtMs: 100,
    updatedAtMs,
    deviceId: "device-1",
    hlcPhysicalMs: updatedAtMs,
    hlcCounter: 0,
  };
}

function revision(
  id = REVISION_ID,
  revisionNumber = 1,
  parentRevisionId: string | null = null,
  updatedAtMs = 100,
): PlanDraftRevisionRecord {
  return {
    id,
    conversationId: CONVERSATION_ID,
    planId: PLAN_ID,
    revision: revisionNumber,
    parentRevisionId,
    status: "ready",
    snapshotJson: "{}",
    raceCourseJson: null,
    createdAtMs: updatedAtMs,
    updatedAtMs,
    deviceId: "device-1",
    hlcPhysicalMs: updatedAtMs,
    hlcCounter: 0,
  };
}

describe("Plan Draft build repository", () => {
  let store: SqlStore & MigratorStore;

  beforeEach(async () => {
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
    await createPlanRepository(store).replace(plan(), [workout()]);
    const conversations = createPlanConversationRepository(store);
    await conversations.saveConversation(conversation());
    await conversations.saveDraftRevision(revision());
  });

  afterEach(async () => {
    await store.close();
  });

  it("commits the Plan, Workouts, conversation, and ready revision together", async () => {
    const repository = createPlanDraftBuildRepository(store);
    await repository.save({
      id: CHECKPOINT_ID,
      conversationId: CONVERSATION_ID,
      buildKey: "revision-2",
      operation: "revise",
      planId: PLAN_ID,
      draftRevisionId: NEXT_REVISION_ID,
      targetRevision: 2,
      completedWeeks: 12,
      totalWeeks: 12,
      payloadJson: JSON.stringify({ schemaVersion: 1, planId: PLAN_ID, workouts: [workout()] }),
      createdAtMs: 200,
      updatedAtMs: 200,
      deviceId: "device-1",
      hlcPhysicalMs: 200,
      hlcCounter: 0,
    });

    await repository.commitReady({
      checkpointId: CHECKPOINT_ID,
      conversation: conversation(300),
      plan: plan("Finish in the front half", 300),
      workouts: [workout("Tempo endurance", 1)],
      draft: revision(NEXT_REVISION_ID, 2, REVISION_ID, 300),
    });

    await expect(createPlanRepository(store).read(PLAN_ID)).resolves.toMatchObject({
      primaryGoal: "Finish in the front half",
    });
    await expect(createPlanRepository(store).readWorkouts(PLAN_ID)).resolves.toMatchObject([
      { name: "Tempo endurance" },
    ]);
    await expect(
      createPlanConversationRepository(store).readLatestDraftRevision(CONVERSATION_ID),
    ).resolves.toMatchObject({ id: NEXT_REVISION_ID, revision: 2, status: "ready" });
    await expect(repository.read(CONVERSATION_ID)).resolves.toBeUndefined();
  });

  it("rolls back the entire ready bundle when the final revision cannot commit", async () => {
    const repository = createPlanDraftBuildRepository(store);
    await repository.save({
      id: CHECKPOINT_ID,
      conversationId: CONVERSATION_ID,
      buildKey: "conflicting-revision-2",
      operation: "revise",
      planId: PLAN_ID,
      draftRevisionId: REVISION_ID,
      targetRevision: 2,
      completedWeeks: 12,
      totalWeeks: 12,
      payloadJson: JSON.stringify({ schemaVersion: 1, planId: PLAN_ID, workouts: [workout()] }),
      createdAtMs: 200,
      updatedAtMs: 200,
      deviceId: "device-1",
      hlcPhysicalMs: 200,
      hlcCounter: 0,
    });

    await expect(
      repository.commitReady({
        checkpointId: CHECKPOINT_ID,
        conversation: conversation(300),
        plan: plan("Must roll back", 300),
        workouts: [workout("Must roll back", 1)],
        draft: revision(REVISION_ID, 2, REVISION_ID, 300),
      }),
    ).rejects.toThrow();

    await expect(createPlanRepository(store).read(PLAN_ID)).resolves.toMatchObject({
      primaryGoal: "Finish comfortably",
    });
    await expect(createPlanRepository(store).readWorkouts(PLAN_ID)).resolves.toMatchObject([
      { name: "Endurance" },
    ]);
    await expect(
      createPlanConversationRepository(store).readDraftRevisions(CONVERSATION_ID),
    ).resolves.toHaveLength(1);
    await expect(repository.read(CONVERSATION_ID)).resolves.toMatchObject({
      id: CHECKPOINT_ID,
      completedWeeks: 12,
    });
  });
});
