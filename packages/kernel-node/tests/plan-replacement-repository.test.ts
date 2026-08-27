import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PlanReplacementValidationError,
  createPlanConversationRepository,
  createPlanReconciliationRepository,
  createPlanReplacementRepository,
  createPlanRepository,
  createPlanSettingsRepository,
  type PlanConversationRecord,
  type PlanDraftRevisionRecord,
  type PlanRecord,
} from "@enduragent/kernel/planning";
import { runMigrations, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "../src/sqlite/index.js";

const PREVIOUS_PLAN_ID = `${"0".repeat(25)}1`;
const REPLACEMENT_PLAN_ID = `${"0".repeat(25)}2`;
const CONVERSATION_ID = `${"0".repeat(25)}3`;
const DRAFT_ID = `${"0".repeat(25)}4`;
const REPLACEMENT_ID = `${"0".repeat(25)}5`;
const CLEANUP_JOB_ID = `${"0".repeat(25)}6`;

function plan(id: string, status: PlanRecord["status"]): PlanRecord {
  return {
    id,
    originId: null,
    name: status === "active" ? "Current Gran Fondo Plan" : "Replacement Gran Fondo Plan",
    primaryGoal: "Finish in the front half",
    startDateKey: 20260709,
    targetDateKey: 20260930,
    status,
    kind: "full_plan",
    totalWeeks: 12,
    weekStartDay: 4,
    structureJson: '{"phases":[]}',
    createdAtMs: 1,
    updatedAtMs: 2,
    deviceId: "device-1",
    hlcPhysicalMs: 2,
    hlcCounter: 0,
  };
}

function conversation(): PlanConversationRecord {
  return {
    id: CONVERSATION_ID,
    planId: REPLACEMENT_PLAN_ID,
    replacesPlanId: PREVIOUS_PLAN_ID,
    courseChoiceStatus: "omitted",
    raceCourseJson: null,
    status: "open",
    endedAtMs: null,
    createdAtMs: 3,
    updatedAtMs: 3,
    deviceId: "device-1",
    hlcPhysicalMs: 3,
    hlcCounter: 0,
  };
}

function draft(overrides: Partial<PlanDraftRevisionRecord> = {}): PlanDraftRevisionRecord {
  return {
    id: DRAFT_ID,
    conversationId: CONVERSATION_ID,
    planId: REPLACEMENT_PLAN_ID,
    revision: 1,
    parentRevisionId: null,
    status: "ready",
    snapshotJson: '{"weeks":12}',
    raceCourseJson: null,
    createdAtMs: 4,
    updatedAtMs: 4,
    deviceId: "device-1",
    hlcPhysicalMs: 4,
    hlcCounter: 0,
    ...overrides,
  };
}

describe("Plan replacement repository", () => {
  let store: SqlStore & MigratorStore;

  beforeEach(async () => {
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
  });

  afterEach(async () => {
    await store.close();
  });

  async function seed(): Promise<void> {
    const plans = createPlanRepository(store);
    const conversations = createPlanConversationRepository(store);
    await plans.replace(plan(PREVIOUS_PLAN_ID, "active"), []);
    await plans.replace(plan(REPLACEMENT_PLAN_ID, "draft"), []);
    await conversations.saveConversation(conversation());
    await conversations.saveDraftRevision(draft());
  }

  it("atomically swaps the active Plan, records lineage, and creates one cleanup job", async () => {
    await seed();
    const repository = createPlanReplacementRepository(store);
    const plans = createPlanRepository(store);
    const conversations = createPlanConversationRepository(store);

    const first = await repository.approve({
      id: REPLACEMENT_ID,
      previousPlanId: PREVIOUS_PLAN_ID,
      replacementPlanId: REPLACEMENT_PLAN_ID,
      draftRevisionId: DRAFT_ID,
      expectedRevision: 1,
      cleanupJobId: CLEANUP_JOB_ID,
      windowStartDateKey: 20260827,
      windowEndDateKey: 20260930,
      updatedAtMs: 20,
      deviceId: "device-1",
      hlcPhysicalMs: 20,
      hlcCounter: 0,
    });
    const repeated = await repository.approve({
      id: `${"0".repeat(25)}7`,
      previousPlanId: PREVIOUS_PLAN_ID,
      replacementPlanId: REPLACEMENT_PLAN_ID,
      draftRevisionId: DRAFT_ID,
      expectedRevision: 1,
      cleanupJobId: `${"0".repeat(25)}8`,
      windowStartDateKey: 20260827,
      windowEndDateKey: 20260930,
      updatedAtMs: 21,
      deviceId: "device-1",
      hlcPhysicalMs: 21,
      hlcCounter: 0,
    });

    expect(first).toMatchObject({ id: REPLACEMENT_ID, cleanupJobId: CLEANUP_JOB_ID });
    expect(repeated).toEqual(first);
    await expect(plans.read(PREVIOUS_PLAN_ID)).resolves.toMatchObject({ status: "ended" });
    await expect(plans.read(REPLACEMENT_PLAN_ID)).resolves.toMatchObject({ status: "active" });
    await expect(conversations.readDraftRevision(DRAFT_ID)).resolves.toMatchObject({
      status: "approved",
    });
    await expect(
      createPlanReconciliationRepository(store).readJob(CLEANUP_JOB_ID),
    ).resolves.toMatchObject({
      planId: PREVIOUS_PLAN_ID,
      kind: "cleanup",
      status: "pending",
      windowStartDateKey: 20260827,
      windowEndDateKey: 20260930,
    });
    await expect(
      createPlanSettingsRepository(store).read(REPLACEMENT_PLAN_ID),
    ).resolves.toMatchObject({ autoApply: false, weeklyReview: true });
  });

  it("leaves both Plans unchanged when the Draft revision is stale", async () => {
    await seed();
    const repository = createPlanReplacementRepository(store);
    await expect(
      repository.approve({
        id: REPLACEMENT_ID,
        previousPlanId: PREVIOUS_PLAN_ID,
        replacementPlanId: REPLACEMENT_PLAN_ID,
        draftRevisionId: DRAFT_ID,
        expectedRevision: 2,
        cleanupJobId: CLEANUP_JOB_ID,
        windowStartDateKey: 20260827,
        windowEndDateKey: 20260930,
        updatedAtMs: 20,
        deviceId: "device-1",
        hlcPhysicalMs: 20,
        hlcCounter: 0,
      }),
    ).rejects.toEqual(new PlanReplacementValidationError("stale-draft"));

    const plans = createPlanRepository(store);
    await expect(plans.read(PREVIOUS_PLAN_ID)).resolves.toMatchObject({ status: "active" });
    await expect(plans.read(REPLACEMENT_PLAN_ID)).resolves.toMatchObject({ status: "draft" });
    await expect(repository.readByReplacementPlanId(REPLACEMENT_PLAN_ID)).resolves.toBeUndefined();
    await expect(
      createPlanReconciliationRepository(store).readLatestJob(PREVIOUS_PLAN_ID, "cleanup"),
    ).resolves.toBeUndefined();
  });
});
