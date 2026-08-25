import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatQueueSnapshot,
  CoachEngine,
  PlanProgressEvent,
  TurnEvent,
} from "@enduragent/coach-contract";
import { createPlanConversationRepository, type PlanRecord } from "@enduragent/kernel/planning";
import { runMigrations, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import type { AuthoredIdentity } from "@enduragent/kernel-node/home";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { createPlanningOperations, type PlanDraftBuilder } from "../src/planning-operations.js";
import type { CoachStoreWriterContext } from "../src/runtime.js";

const EMPTY_QUEUE: ChatQueueSnapshot = { schemaVersion: 1, revision: 0, items: [] };
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function identity(): AuthoredIdentity {
  let sequence = 0;
  let clock = 100;
  return {
    deviceId: async () => "device-1",
    newUlid() {
      sequence += 1;
      return `${"0".repeat(25)}${ALPHABET[sequence]}`;
    },
    hlcStamp() {
      clock += 1;
      return { physicalMs: clock, counter: 0 };
    },
  };
}

function engine(): CoachEngine {
  return {
    chat: vi.fn(async (request, onEvent) => {
      onEvent?.({ type: "turn-start", turnId: "engine-turn-1", chatId: request.chatId });
      onEvent?.({ type: "text_delta", turnId: "engine-turn-1", delta: "I found your rides." });
      onEvent?.({ type: "final-text", turnId: "engine-turn-1", text: "I found your rides." });
      return { text: "I found your rides." };
    }),
    getChatQueue: async () => EMPTY_QUEUE,
    getCoachDecision: async () => ({ decision: null }),
    answerCoachDecision: vi.fn(),
    skipCoachDecision: vi.fn(),
    resumeCoachDecision: vi.fn(),
    resetSession: async () => ({ memoryFlushed: true }),
    hasSession: async () => ({ hasSession: true }),
    getAthleteState: vi.fn(),
  } as unknown as CoachEngine;
}

function plan(id: string, timestamp: number): PlanRecord {
  return {
    id,
    originId: null,
    name: "Gran Fondo Plan",
    primaryGoal: "Finish in the front half",
    startDateKey: 20260709,
    targetDateKey: 20260930,
    status: "draft",
    kind: "full_plan",
    totalWeeks: 12,
    weekStartDay: 4,
    structureJson: '{"phases":[]}',
    createdAtMs: timestamp,
    updatedAtMs: timestamp,
    deviceId: "device-1",
    hlcPhysicalMs: timestamp,
    hlcCounter: 0,
  };
}

describe("Plan operations", () => {
  let store: SqlStore & MigratorStore;
  let context: CoachStoreWriterContext;

  beforeEach(async () => {
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
    context = {
      home: {
        root: "/synthetic/athlete",
        storeDir: "/synthetic/athlete/store",
        archiveDir: "/synthetic/athlete/archive",
        configDir: "/synthetic/athlete/config",
      },
      store,
      listener: {} as CoachStoreWriterContext["listener"],
    };
  });

  afterEach(async () => {
    await store.close();
  });

  it("persists and relaunches a dedicated streamed Plan conversation", async () => {
    const coach = engine();
    const authored = identity();
    const readiness = {
      isReady: ({ turns }: { readonly turns: readonly unknown[] }) => turns.length > 0,
    };
    const operations = createPlanningOperations(
      { context, engine: coach, identity: authored },
      readiness,
    );
    const started = await operations.executePlanTransition?.({
      transitionId: "PL-T01",
      commandId: "command-1",
      sourceConversationId: null,
    });
    expect(started).toMatchObject({
      status: "completed",
      state: { scenarioId: "PL-S017", projection: "coach" },
    });
    if (started?.status !== "completed") throw new TypeError("Plan conversation did not start.");
    const conversationId = started.state.data.conversationId;
    if (typeof conversationId !== "string") throw new TypeError("Conversation id missing.");
    const progress: PlanProgressEvent[] = [];
    const sent = await operations.executePlanTransition?.(
      {
        transitionId: "PL-T05",
        commandId: "command-2",
        conversationId,
        text: "Gran Fondo Almaty on 4 October.",
      },
      (event) => progress.push(event),
    );
    expect(sent).toMatchObject({
      status: "completed",
      state: { scenarioId: "PL-S016", projection: "coach" },
    });
    expect(progress.map((event) => event.phase)).toEqual([
      "queued",
      "running",
      "running",
      "running",
      "completed",
    ]);
    expect(coach.chat).toHaveBeenCalledWith(
      { chatId: `plan:${conversationId}`, message: "Gran Fondo Almaty on 4 October." },
      expect.any(Function),
    );
    const repository = createPlanConversationRepository(store);
    await expect(repository.readTurns(conversationId)).resolves.toMatchObject([
      {
        sequence: 1,
        athleteText: "Gran Fondo Almaty on 4 October.",
        coachText: "I found your rides.",
      },
    ]);
    const restored = createPlanningOperations(
      { context, engine: coach, identity: authored },
      readiness,
    );
    await expect(restored.getPlanState?.({})).resolves.toMatchObject({
      status: "ready",
      state: {
        scenarioId: "PL-S016",
        data: {
          conversationId,
          messages: [
            { role: "coach" },
            { role: "athlete", text: "Gran Fondo Almaty on 4 October." },
            { role: "coach", text: "I found your rides." },
          ],
        },
      },
    });
  });

  it("forms, revises, and discards a Draft without deleting the Plan conversation", async () => {
    const authored = identity();
    const coach = engine();
    let revision = 0;
    const builder: PlanDraftBuilder = {
      async form() {
        revision += 1;
        return {
          plan: plan(`${"0".repeat(25)}T`, 200),
          workouts: [],
          snapshot: { completeWeeks: 12, revision },
        };
      },
      async revise() {
        revision += 1;
        return {
          plan: plan(`${"0".repeat(25)}T`, 201),
          workouts: [],
          snapshot: { completeWeeks: 12, revision },
        };
      },
    };
    const operations = createPlanningOperations(
      { context, engine: coach, identity: authored },
      { draftBuilder: builder, isReady: () => true },
    );
    const started = await operations.executePlanTransition?.({
      transitionId: "PL-T01",
      commandId: "command-1",
      sourceConversationId: null,
    });
    if (started?.status !== "completed") throw new TypeError("Plan conversation did not start.");
    const conversationId = String(started.state.data.conversationId);
    const formed = await operations.executePlanTransition?.({
      transitionId: "PL-T06",
      commandId: "command-2",
      conversationId,
    });
    expect(formed).toMatchObject({
      status: "completed",
      state: { scenarioId: "PL-S002", revision: 1 },
    });
    if (formed?.status !== "completed") throw new TypeError("Draft did not form.");
    const firstDraft = formed.state.data.draft;
    if (firstDraft === null || typeof firstDraft !== "object")
      throw new TypeError("Draft missing.");
    const draftId = String((firstDraft as { id: unknown }).id);
    const revised = await operations.executePlanTransition?.({
      transitionId: "PL-T07",
      commandId: "command-3",
      draftId,
      text: "Move Thursday endurance to Wednesday.",
    });
    expect(revised).toMatchObject({
      status: "completed",
      state: { scenarioId: "PL-S031", revision: 2 },
    });
    if (revised?.status !== "completed") throw new TypeError("Draft did not revise.");
    const secondDraft = revised.state.data.draft;
    if (secondDraft === null || typeof secondDraft !== "object")
      throw new TypeError("Draft missing.");
    const secondDraftId = String((secondDraft as { id: unknown }).id);
    const discarded = await operations.executePlanTransition?.({
      transitionId: "PL-T10",
      commandId: "command-4",
      draftId: secondDraftId,
    });
    expect(discarded).toMatchObject({
      status: "completed",
      state: { scenarioId: "PL-S020", projection: "coach" },
    });
    await expect(
      createPlanConversationRepository(store).readConversation(conversationId),
    ).resolves.toMatchObject({ status: "open" });
  });

  it("retries an interrupted Plan queue claim and persists the recovered turn", async () => {
    const recoveredQueue = {
      schemaVersion: 1 as const,
      revision: 2,
      items: [
        {
          queuedMessageId: "queued-1",
          submissionId: "submission-1",
          text: "Keep Sunday free.",
          kind: "ordinary" as const,
          position: 0,
          restored: true,
        },
      ],
      retryRequired: {
        claimId: "claim-1",
        queuedMessageIds: ["queued-1"],
        turnId: "turn-1",
        status: "retry-required" as const,
      },
    };
    const retryQueuedTurn = vi.fn(
      async (
        _request: { readonly chatId: string; readonly claimId: string },
        onEvent?: (event: TurnEvent) => void,
      ) => {
        onEvent?.({
          type: "turn-start",
          turnId: "turn-recovered",
          chatId: `plan:${"0".repeat(25)}1`,
        });
        onEvent?.({ type: "final-text", turnId: "turn-recovered", text: "Sunday stays free." });
        return { snapshot: EMPTY_QUEUE, response: { text: "Sunday stays free." } };
      },
    );
    const coach = {
      ...engine(),
      getChatQueue: vi
        .fn()
        .mockResolvedValueOnce(EMPTY_QUEUE)
        .mockResolvedValueOnce(recoveredQueue)
        .mockResolvedValue(EMPTY_QUEUE),
      retryQueuedTurn,
    } as unknown as CoachEngine;
    const operations = createPlanningOperations({ context, engine: coach, identity: identity() });
    const started = await operations.executePlanTransition?.({
      transitionId: "PL-T01",
      commandId: "command-1",
      sourceConversationId: null,
    });
    if (started?.status !== "completed") throw new TypeError("Plan conversation did not start.");
    const conversationId = String(started.state.data.conversationId);

    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T05",
        commandId: "command-2",
        conversationId,
        text: "Keep Sunday free.",
      }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(retryQueuedTurn).toHaveBeenCalledWith(
      { chatId: `plan:${conversationId}`, claimId: "claim-1" },
      expect.any(Function),
    );
    await expect(
      createPlanConversationRepository(store).readTurns(conversationId),
    ).resolves.toMatchObject([
      { athleteText: "Keep Sunday free.", coachText: "Sunday stays free." },
    ]);
  });
});
