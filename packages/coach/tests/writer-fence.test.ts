import { describe, expect, it, onTestFinished, vi } from "vitest";
import type {
  CoachEngine,
  ExecutePlanTransitionRpcParams,
  PlanCreationAnswerInput,
} from "@enduragent/coach-contract";
import { canonicalJson } from "@enduragent/kernel/archive";
import {
  createLegacyWriterFence,
  createPlanConversationRepository,
  createPlanCreationRepository,
  createPlanRepository,
  createPlanWorkoutMatchRepository,
} from "@enduragent/kernel/planning";
import { dumpStore, runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { inertWriterProtocolListener } from "@enduragent/kernel-node/lock";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { createPlanCreationOperations } from "../src/plan-creation-operations.js";
import { createPlanningOperations } from "../src/planning-operations.js";
import type { CoachStoreWriterContext } from "../src/runtime.js";

const MESSAGE = "This Plan is managed in Chat. Change or stop it from Chat or the Plan library.";
const CONVERSATION_ID = "00000000000000000000000001";

async function fixture(
  status: "empty" | "in-progress" | "review" | "active" | "closed" | "discarded",
) {
  const store = openSqliteStorage(":memory:");
  onTestFinished(() => store.close());
  await runMigrations(store, MIGRATIONS);
  let sequence = 100;
  const identity = {
    deviceId: async () => "writer-fence-test-device",
    newUlid: () => String(++sequence).padStart(26, "0"),
    hlcStamp: () => ({ physicalMs: 904_694_400_000, counter: sequence }),
  };
  const dependencies = {
    store,
    identity,
    crypto: globalThis.crypto,
    todayDateKey: () => 19980902,
    now: () => 904_694_400_000,
  };
  const creation = createPlanCreationOperations({
    ...dependencies,
    repository: createPlanCreationRepository(store),
    eventCandidates: { read: async () => [] },
    today: () => "1998-09-02",
  });
  const seed = async () => {
    if (status === "empty") return { creationId: null, planId: null };
    const start = await creation["plan_creation.start"]({ commandId: "start" });
    if (start.status !== "started") throw new Error("Expected creation");
    let card = start.planCreation;
    if (status === "in-progress") return { creationId: card.creationId, planId: null };
    if (status === "discarded") {
      await creation["plan_creation.discard"]({
        commandId: "discard",
        creationId: card.creationId,
        expectedVersion: card.version,
      });
      return { creationId: card.creationId, planId: null };
    }
    const answers: PlanCreationAnswerInput[] = [
      { kind: "goal", goal: { kind: "fitness" } },
      { kind: "plan-length", weeks: 4 },
      { kind: "schedule-mode", mode: "fixed" },
      {
        kind: "availability",
        mode: "fixed",
        weeklyHoursLimit: 8,
        longestWorkoutHours: 3,
        usableWeekdays: [6, 2, 4],
      },
      { kind: "start-timing", timing: { kind: "as-soon-as-possible" } },
      { kind: "commitments", commitments: { kind: "none" } },
      { kind: "baseline", baseline: "regular" },
      { kind: "success", success: { kind: "fitness-choice", choice: "climb-stronger" } },
      { kind: "restriction", restriction: { kind: "none" } },
    ];
    for (const answer of answers) {
      const result = await creation["plan_creation.answer"]({
        commandId: `answer-${++sequence}`,
        creationId: card.creationId,
        expectedVersion: card.version,
        answer,
      });
      if (result.status !== "answered") throw new Error("Expected answer");
      card = result.planCreation;
    }
    const draftResult = await creation["plan_creation.preview"]({
      commandId: "draft",
      creationId: card.creationId,
      expectedVersion: card.version,
    });
    if (draftResult.status !== "previewed" || draftResult.planCreation.draft === null)
      throw new Error("Expected Draft");
    if (status === "review") return { creationId: card.creationId, planId: null };
    const activated = await creation["plan_creation.activate"]({
      commandId: "activate",
      creationId: card.creationId,
      expectedVersion: draftResult.planCreation.version,
    });
    expect(activated.planId).toBeTruthy();
    const listed = await creation["plan.list"]({});
    if (listed.active === null) throw new Error("Expected active Plan summary");
    const planId = listed.active.planId;
    if (status === "closed") {
      await creation["plan.close"]({ commandId: "close", planId, expectedVersion: 1 });
    }
    return { creationId: card.creationId, planId };
  };
  const ids = await seed();
  const context: CoachStoreWriterContext = {
    home: {
      root: "/synthetic/athlete",
      storeDir: "/synthetic/athlete/store",
      archiveDir: "/synthetic/athlete/archive",
      configDir: "/synthetic/athlete/config",
    },
    store,
    listener: inertWriterProtocolListener,
  };
  const unsupported = async (): Promise<never> => {
    throw new Error("Unexpected engine call");
  };
  const engine: CoachEngine = {
    chat: vi.fn(unsupported),
    answerCoachDecision: unsupported,
    skipCoachDecision: unsupported,
    resumeCoachDecision: unsupported,
    resetSession: unsupported,
    hasSession: unsupported,
    getAthleteState: unsupported,
    getChatQueue: async () => ({ schemaVersion: 1, revision: 0, items: [] }),
    getCoachDecision: async () => ({ decision: null }),
  };
  const operations = createPlanningOperations(
    { context, engine, identity },
    { todayDateKey: () => 19980902 },
  );
  const openConversation = async () => {
    const conversations = createPlanConversationRepository(store);
    await conversations.saveConversation({
      id: CONVERSATION_ID,
      planId: null,
      replacesPlanId: null,
      courseChoiceStatus: "omitted",
      raceCourseJson: null,
      status: "open",
      endedAtMs: null,
      createdAtMs: 100,
      updatedAtMs: 100,
      deviceId: "fence-test-device",
      hlcPhysicalMs: 100,
      hlcCounter: 0,
    });
    await conversations.appendTurn({
      id: "00000000000000000000000002",
      conversationId: CONVERSATION_ID,
      sequence: 1,
      athleteText: "Improve my climbing.",
      coachText: "We can build toward that.",
      lineageJson: canonicalJson({ planIntakePatch: { goal: "Improve my climbing" } }),
      completedAtMs: 101,
      deviceId: "fence-test-device",
      hlcPhysicalMs: 101,
      hlcCounter: 0,
    });
  };
  return { store, operations, openConversation, creation, context, engine, identity, ...ids };
}

function commands(planId: string): ExecutePlanTransitionRpcParams[] {
  return [
    { transitionId: "PL-T01", commandId: "start-legacy", sourceConversationId: null },
    {
      transitionId: "PL-T11",
      commandId: "activate-legacy",
      draftId: CONVERSATION_ID,
      expectedRevision: 1,
    },
    {
      transitionId: "PL-T17",
      commandId: "proposal-legacy",
      planId,
      proposalId: CONVERSATION_ID,
      selectedProposalReturn: { sourceScenarioId: "PL-S010", returnFocusId: "workout-row" },
    },
    { transitionId: "PL-T21", commandId: "undo-legacy", planId, ledgerId: CONVERSATION_ID },
    { transitionId: "PL-T24", commandId: "stop-legacy", planId, mode: "cleanup" },
    {
      transitionId: "PL-T26",
      commandId: "replace-legacy",
      activePlanId: planId,
      draftId: CONVERSATION_ID,
      expectedRevision: 1,
      confirm: true,
    },
  ];
}

describe("legacy writer fence", () => {
  it.each(["in-progress", "review"] as const)(
    "rejects with %s creation without engine reads or store writes",
    async (status) => {
      const test = await fixture(status);
      await test.openConversation();
      const getChatQueue = vi.spyOn(test.engine, "getChatQueue");
      const getCoachDecision = vi.spyOn(test.engine, "getCoachDecision");
      const before = await dumpStore(test.store);

      await expect(
        test.operations.executePlanTransition?.({
          transitionId: "PL-T01",
          commandId: "fenced-legacy-start",
          sourceConversationId: null,
        }),
      ).resolves.toMatchObject({
        status: "rejected",
        error: { code: "conflict", message: MESSAGE },
        state: { projection: "coach" },
      });

      expect(getChatQueue).not.toHaveBeenCalled();
      expect(getCoachDecision).not.toHaveBeenCalled();
      expect(await dumpStore(test.store)).toBe(before);
    },
  );

  it("retains natural completion while target ownership remains active", async () => {
    const test = await fixture("active");
    if (test.planId === null) throw new Error("Expected active Plan");
    const planId = test.planId;
    const plans = createPlanRepository(test.store);
    const plan = await plans.read(planId);
    if (plan === undefined) throw new Error("Expected Plan record");
    await plans.replace(
      {
        ...plan,
        name: "Gran Fondo Plan",
        primaryGoal: "Finish",
        startDateKey: 19980713,
        targetDateKey: 19981004,
        kind: "full_plan",
        totalWeeks: 12,
        weekStartDay: 1,
      },
      [],
    );
    let todayDateKey = 19981004;
    const operations = createPlanningOperations(
      { context: test.context, engine: test.engine, identity: test.identity },
      { plans, todayDateKey: () => todayDateKey },
    );

    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T29",
        commandId: "natural-too-early",
        planId,
        asOf: "1998-10-04",
      }),
    ).resolves.toMatchObject({ status: "rejected" });
    await expect(plans.read(planId)).resolves.toMatchObject({ status: "active" });

    todayDateKey = 19981005;
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T29",
        commandId: "natural-completion",
        planId,
        asOf: "1998-10-05",
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: { lifecycle: "ended", projection: "ended", scenarioId: "PL-S094" },
    });
    await expect(plans.read(planId)).resolves.toMatchObject({ status: "ended" });
    await expect(createLegacyWriterFence(test.store).read()).resolves.toMatchObject({
      activePlanId: planId,
    });
    await expect(operations.getPlanState?.({})).resolves.toMatchObject({
      status: "ready",
      state: { lifecycle: "ended", projection: "ended" },
    });
  });

  it.each(["in-progress", "review", "active"] as const)(
    "reads %s ownership without writes",
    async (status) => {
      const test = await fixture(status);
      const fence = createLegacyWriterFence(test.store);
      const before = await dumpStore(test.store);
      expect(await fence.read()).toEqual({
        activePlanId: status === "active" ? test.planId : null,
        creationId: status === "active" ? null : test.creationId,
      });
      expect(await fence.fenced()).toBe(true);
      expect(await dumpStore(test.store)).toBe(before);
    },
  );

  it.each(["in-progress", "review", "active"] as const)(
    "rejects authoring families with %s ownership and preserves the entire store",
    async (status) => {
      const test = await fixture(status);
      await test.openConversation();
      let operations = test.operations;
      if (test.planId !== null) {
        const [workout] = await createPlanRepository(test.store).readWorkouts(test.planId);
        if (workout === undefined) throw new Error("Expected Workout");
        operations = createPlanningOperations(
          { context: test.context, engine: test.engine, identity: test.identity },
          {
            todayDateKey: () => 19980902,
            workoutMatches: {
              ...createPlanWorkoutMatchRepository(test.store),
              listActivities: async () => [
                {
                  activityId: "b".repeat(64),
                  providerActivityId: "synthetic-unmatched-activity",
                  dateKey: workout.dateKey,
                  sport: workout.sport,
                  durationS: workout.durationS,
                  pairedEventId: null,
                },
              ],
            },
          },
        );
      }
      const before = await dumpStore(test.store);
      for (const command of commands(test.planId ?? CONVERSATION_ID)) {
        const result = await operations.executePlanTransition?.(command);
        expect(result).toMatchObject({
          status: "rejected",
          error: { code: "conflict", message: MESSAGE },
          state: { projection: status === "active" ? "active" : "coach" },
        });
        expect(await dumpStore(test.store)).toBe(before);
      }
    },
  );

  it.each(["empty", "closed", "discarded"] as const)(
    "permits legacy authoring with %s ownership",
    async (status) => {
      const test = await fixture(status);
      const fence = createLegacyWriterFence(test.store);
      const before = await dumpStore(test.store);
      expect(await fence.read()).toEqual({ activePlanId: null, creationId: null });
      expect(await fence.fenced()).toBe(false);
      expect(await dumpStore(test.store)).toBe(before);
      await expect(
        test.operations.executePlanTransition?.({
          transitionId: "PL-T01",
          commandId: "legacy-start",
          sourceConversationId: null,
        }),
      ).resolves.toMatchObject({ status: "completed" });
    },
  );

  it("prefers the active Chat Plan over an open legacy conversation without intake writes", async () => {
    const test = await fixture("active");
    await test.openConversation();
    const before = await dumpStore(test.store);
    await expect(test.operations.getPlanState?.({})).resolves.toMatchObject({
      status: "ready",
      state: {
        projection: "active",
        planId: test.planId,
        data: { plan: { id: test.planId, name: "Improve fitness" }, workouts: expect.any(Array) },
      },
    });
    expect(await dumpStore(test.store)).toBe(before);
  });

  it("checks ownership when a queued command enters the serialized lane", async () => {
    const test = await fixture("empty");
    let signalEntered: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const operations = createPlanningOperations(
      { context: test.context, engine: test.engine, identity: test.identity },
      {
        todayDateKey: () => 19980902,
        isReady: async () => {
          calls += 1;
          if (calls === 1) {
            signalEntered();
            await released;
          }
          return false;
        },
      },
    );
    const first = operations.executePlanTransition?.({
      transitionId: "PL-T01",
      commandId: "first",
      sourceConversationId: null,
    });
    await entered;
    const queued = operations.executePlanTransition?.({
      transitionId: "PL-T01",
      commandId: "queued",
      sourceConversationId: null,
    });
    await test.creation["plan_creation.start"]({ commandId: "chat-start" });
    release();
    await expect(first).resolves.toMatchObject({ status: "completed" });
    await expect(queued).resolves.toMatchObject({
      status: "rejected",
      error: { code: "conflict", message: MESSAGE },
    });
  });

  it("retains Workout match confirmation while a Chat Plan is active", async () => {
    const test = await fixture("active");
    if (test.planId === null) throw new Error("Expected active Plan");
    const [workout] = await createPlanRepository(test.store).readWorkouts(test.planId);
    if (workout === undefined) throw new Error("Expected Workout");
    const matches = createPlanWorkoutMatchRepository(test.store);
    const activityId = "a".repeat(64);
    const matchId = "00000000000000000000000003";
    await matches.observe({
      id: matchId,
      planId: test.planId,
      planWorkoutId: workout.id,
      activityId,
      providerActivityId: "synthetic-activity",
      providerEventId: null,
      source: "heuristic",
      decision: "suggested",
      activityDateKey: workout.dateKey,
      activitySport: workout.sport,
      activityDurationS: workout.durationS,
      observedAtMs: 100,
      decidedAtMs: null,
      deviceId: "fence-test-device",
      hlcPhysicalMs: 100,
      hlcCounter: 0,
    });
    await expect(
      test.operations.executePlanTransition?.({
        transitionId: "PL-T14",
        commandId: "confirm-match",
        planId: test.planId,
        workoutId: workout.id,
        activityId,
        decision: "confirm",
      }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(await matches.readForWorkout(workout.id)).toMatchObject([
      { id: matchId, decision: "confirmed" },
    ]);
  });
});
