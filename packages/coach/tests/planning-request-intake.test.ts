import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parsePlanProposalMutation } from "@enduragent/engine";
import {
  createPlanConversationRepository,
  createPlanningRequestIntakeRepository,
  createPlanningRequestRepository,
  createPlanProposalRepository,
  createPlanRepository,
  type CreatePlanningRequestPayload,
  type PlanConversationRecord,
  type PlanRecord,
  type PlanWorkoutRecord,
  type PlanningRequestTarget,
} from "@enduragent/kernel/planning";
import { runMigrations, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { createNodeCrypto } from "@enduragent/kernel-node/ingest";
import type { AuthoredIdentity } from "@enduragent/kernel-node/home";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import {
  createPlanningRequestIntakeService,
  createPlanningRequestPremiseReader,
} from "../src/planning-request-intake.js";

const PLAN_ID = "01J60HFQ7T0000000000000000";
const CONVERSATION_ID = "01J60HFQ7T0000000000000001";
const WORKOUT_ID = "01J60HFQ7T0000000000000002";

const workoutLimits = {
  candidates: 8,
  segmentsPerWorkout: 128,
  durationSeconds: 86_400,
  diagnostics: 32,
  diagnosticChars: 1_000,
  titleChars: 512,
  purposeChars: 2_000,
} as const;

function payload(requestId = "request-1"): CreatePlanningRequestPayload {
  return {
    requestId,
    kind: "workout_review",
    intent: "Review this Workout before I add it to my Plan.",
    source: {
      chatId: "chat-1",
      messageId: `message-${requestId}`,
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
          workoutId: "workout-1",
          title: "Tempo 3 × 12",
          sport: "cycling",
          durationSeconds: 3_840,
          purpose: "Build sustainable power.",
          segments: [
            {
              segmentId: "segment-1",
              kind: "steady",
              seconds: 3_840,
              power: { kind: "ftp_percent_range", low: 88, high: 92 },
            },
          ],
        },
      },
    },
    requestedDate: "1998-08-26",
  };
}

function plan(status: PlanRecord["status"]): PlanRecord {
  return {
    id: PLAN_ID,
    originId: null,
    name: "Autumn base",
    primaryGoal: "Build consistency",
    startDateKey: 19980824,
    targetDateKey: null,
    status,
    kind: "full_plan",
    totalWeeks: 12,
    weekStartDay: 1,
    structureJson: "{}",
    createdAtMs: 1,
    updatedAtMs: 10,
    deviceId: "device-1",
    hlcPhysicalMs: 10,
    hlcCounter: 0,
  };
}

function planWorkout(dateKey: number): PlanWorkoutRecord {
  return {
    id: WORKOUT_ID,
    planId: PLAN_ID,
    dateKey,
    sport: "cycling",
    name: "Easy endurance",
    durationS: 3_000,
    structureJson: "{}",
    origin: "coach",
    deviceId: "device-1",
    hlcPhysicalMs: 10,
    hlcCounter: 0,
  };
}

function conversation(planId: string): PlanConversationRecord {
  return {
    id: CONVERSATION_ID,
    planId,
    replacesPlanId: null,
    courseChoiceStatus: "undecided",
    raceCourseJson: null,
    status: "open",
    endedAtMs: null,
    createdAtMs: 20,
    updatedAtMs: 20,
    deviceId: "device-1",
    hlcPhysicalMs: 20,
    hlcCounter: 0,
  };
}

describe("Planning request intake", () => {
  let store: SqlStore & MigratorStore;
  let identity: AuthoredIdentity;
  let instant: number;
  let idCounter: number;

  beforeEach(async () => {
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
    instant = 100;
    idCounter = 10;
    identity = {
      deviceId: async () => "device-1",
      newUlid: () => {
        const suffix = String(idCounter++).padStart(2, "0");
        return `${PLAN_ID.slice(0, -2)}${suffix}`;
      },
      hlcStamp: () => ({ physicalMs: instant++, counter: 0 }),
    };
  });

  afterEach(async () => store.close());

  const setup = async (
    target: PlanningRequestTarget,
    planStatus?: PlanRecord["status"],
    workouts: readonly PlanWorkoutRecord[] = [],
    requestPayload: CreatePlanningRequestPayload = payload(),
  ) => {
    const plans = createPlanRepository(store);
    const conversations = createPlanConversationRepository(store);
    const requests = createPlanningRequestRepository(store, createNodeCrypto());
    if (planStatus !== undefined) await plans.replace(plan(planStatus), workouts);
    const record = await requests.createOrGet({
      payload: requestPayload,
      target,
      createdAtMs: 50,
      deviceId: "device-1",
      hlcPhysicalMs: 50,
      hlcCounter: 0,
    });
    const accept = createPlanningRequestIntakeService({
      requests,
      intake: createPlanningRequestIntakeRepository(store),
      plans,
      conversations,
      identity,
      workoutLimits,
      todayDateKey: () => 19980824,
    });
    return { plans, conversations, requests, record, accept };
  };

  it("creates one reviewable addition Proposal and reopens it without duplication", async () => {
    const context = await setup("active_plan", "active");
    const accepted = await context.accept(context.record);

    expect(accepted.request).toMatchObject({
      proposalId: expect.any(String),
      planConversationId: null,
      attention: "needs_review",
      resolvedDateKey: 19980826,
      revision: 2,
    });
    const proposals = createPlanProposalRepository(store);
    const proposal = await proposals.read(accepted.request.proposalId!);
    expect(proposal).toMatchObject({
      planId: PLAN_ID,
      status: "proposed",
      title: "Add Tempo 3 × 12",
    });
    expect(parsePlanProposalMutation(proposal!.mutationJson).changes[0]).toMatchObject({
      before: null,
      after: { dateKey: 19980826, name: "Tempo 3 × 12", durationS: 3_840 },
    });
    const premises = await proposals.readPremises(proposal!.id);
    expect(premises).toHaveLength(1);
    expect(premises[0]).toMatchObject({
      sourceType: "planning_request",
      sourceId: "request-1",
      sourceLabel: "tempo-3x12.mrc",
    });
    await expect(
      createPlanningRequestPremiseReader(context.requests).read({
        sourceType: "planning_request",
        sourceId: "request-1",
      }),
    ).resolves.toBe(premises[0]!.snapshotJson);

    await expect(context.accept(accepted)).resolves.toEqual(accepted);
    await expect(proposals.readOpenForPlan(PLAN_ID)).resolves.toHaveLength(1);
  });

  it("records an occupied requested date as a conflict without mutating Plan", async () => {
    const context = await setup("active_plan", "active", [planWorkout(19980826)]);
    const accepted = await context.accept(context.record);

    expect(accepted.request).toMatchObject({
      proposalId: expect.any(String),
      attention: "date_conflict",
      requestedDateKey: 19980826,
      resolvedDateKey: null,
    });
    expect(await context.plans.readWorkouts(PLAN_ID)).toEqual([planWorkout(19980826)]);
  });

  it("binds a Draft request to its exact open Plan conversation", async () => {
    const context = await setup("draft", "draft");
    await context.conversations.saveConversation(conversation(PLAN_ID));
    const accepted = await context.accept(context.record);

    expect(accepted.request).toMatchObject({
      planConversationId: CONVERSATION_ID,
      proposalId: null,
      attention: "none",
      revision: 2,
    });
    const source = await context.conversations.readSourceRequests(CONVERSATION_ID);
    expect(source).toHaveLength(1);
    expect(source[0]).toMatchObject({
      sourceChatId: "chat-1",
      sourceMessageId: "message-request-1",
    });
  });

  it("binds an active Plan question to its conversation without inventing a Proposal", async () => {
    const question: CreatePlanningRequestPayload = {
      requestId: "request-question",
      kind: "plan_question",
      intent: "How does this Workout support my current phase?",
      source: { chatId: "chat-1", messageId: "message-question" },
      sourceSnapshot: {
        capturedAt: "1998-08-24T08:00:00.000Z",
        attachment: null,
        selectedWorkout: null,
      },
    };
    const context = await setup("active_plan", "active", [planWorkout(19980825)], question);
    await context.conversations.saveConversation(conversation(PLAN_ID));
    const accepted = await context.accept(context.record);

    expect(accepted.request).toMatchObject({
      planConversationId: CONVERSATION_ID,
      proposalId: null,
      attention: "none",
    });
  });

  it("creates one Plan-creation conversation with the selected Workout as source context", async () => {
    const context = await setup("plan_creation");
    const accepted = await context.accept(context.record);

    expect(accepted.request).toMatchObject({
      planConversationId: expect.any(String),
      proposalId: null,
      attention: "none",
      revision: 2,
    });
    const conversationRecord = await context.conversations.readConversation(
      accepted.request.planConversationId!,
    );
    expect(conversationRecord).toMatchObject({ planId: null, status: "open" });
    await expect(
      context.conversations.readSourceRequests(accepted.request.planConversationId!),
    ).resolves.toHaveLength(1);
  });

  it("leaves the request unbound when destination persistence rolls back", async () => {
    const context = await setup("draft", "draft");
    await context.conversations.saveConversation(conversation(PLAN_ID));
    await context.conversations.createOrGetSourceRequest({
      id: `${PLAN_ID.slice(0, -2)}10`,
      conversationId: CONVERSATION_ID,
      sourceChatId: "another-chat",
      sourceBoundaryRef: null,
      sourceMessageId: "another-message",
      requestJson: "{}",
      createdAtMs: 30,
      updatedAtMs: 30,
      deviceId: "device-1",
      hlcPhysicalMs: 30,
      hlcCounter: 0,
    });

    await expect(context.accept(context.record)).rejects.toThrow();
    await expect(context.requests.read("request-1")).resolves.toMatchObject({
      request: { planConversationId: null, proposalId: null, revision: 1 },
    });
    await expect(context.conversations.readSourceRequests(CONVERSATION_ID)).resolves.toHaveLength(
      1,
    );
  });
});
