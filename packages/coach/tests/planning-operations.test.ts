import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatQueueSnapshot,
  CoachEngine,
  PlanProgressEvent,
  TurnEvent,
} from "@enduragent/coach-contract";
import {
  createPlanConversationRepository,
  createPlanRepository,
  createRaceCourseSnapshot,
  type PlanRecord,
  type RaceCourseSnapshot,
} from "@enduragent/kernel/planning";
import { runMigrations, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import type { AuthoredIdentity } from "@enduragent/kernel-node/home";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import type { PlanFtpAdapter, PlanFtpSnapshot } from "@enduragent/engine";
import { createPlanningOperations, type PlanDraftBuilder } from "../src/planning-operations.js";
import type { PlanRaceCourseAdapter } from "../src/planning-race-course.js";
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

function course(
  fileName: string,
  elevationStatus: "available" | "unavailable" = "available",
): RaceCourseSnapshot {
  return createRaceCourseSnapshot({
    fileName,
    route: {
      format: "gpx",
      segments: [
        {
          points: [
            {
              latitude: 43.2,
              longitude: 76.8,
              elevationM: elevationStatus === "available" ? 900 : null,
            },
            {
              latitude: 43.3,
              longitude: 76.9,
              elevationM: elevationStatus === "available" ? 960 : null,
            },
          ],
        },
      ],
    },
    preview: {
      pointCount: 2,
      distanceM: 14_000,
      elevationGainM: elevationStatus === "available" ? 60 : null,
      elevationStatus,
    },
  });
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
      state: { scenarioId: "PL-S017", projection: "coach" },
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
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T03",
        commandId: "command-3",
        conversationId,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: { scenarioId: "PL-S016", projection: "coach" },
    });
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
      async recalculateCourse() {
        revision += 1;
        return {
          plan: plan(`${"0".repeat(25)}T`, 202),
          workouts: [],
          snapshot: { completeWeeks: 12, revision },
        };
      },
    };
    const operations = createPlanningOperations(
      { context, engine: coach, identity: authored },
      { draftBuilder: builder, isReady: () => true, todayDateKey: () => 20260709 },
    );
    const started = await operations.executePlanTransition?.({
      transitionId: "PL-T01",
      commandId: "command-1",
      sourceConversationId: null,
    });
    if (started?.status !== "completed") throw new TypeError("Plan conversation did not start.");
    const conversationId = String(started.state.data.conversationId);
    await operations.executePlanTransition?.({
      transitionId: "PL-T03",
      commandId: "command-course-choice",
      conversationId,
    });
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

  it("resolves manual and Intervals FTP sources before returning to the Plan coach", async () => {
    let snapshot: PlanFtpSnapshot = {
      manual: null,
      intervalsFtp: null,
      intervalsEftp: null,
      usedSource: null,
      usedWatts: null,
      conflict: false,
    };
    const saveManual = vi.fn(async (watts: number) => {
      snapshot = {
        ...snapshot,
        manual: { watts, refreshedAtMs: 10 },
        usedSource: "manual",
        usedWatts: watts,
      };
      return snapshot;
    });
    const refreshIntervals = vi.fn(async () => snapshot);
    const ftp: PlanFtpAdapter = { read: async () => snapshot, saveManual, refreshIntervals };
    const operations = createPlanningOperations(
      { context, engine: engine(), identity: identity() },
      { ftp, isReady: () => true },
    );
    const started = await operations.executePlanTransition?.({
      transitionId: "PL-T01",
      commandId: "command-1",
      sourceConversationId: null,
    });
    expect(started).toMatchObject({ status: "completed", state: { scenarioId: "PL-S003" } });
    if (started?.status !== "completed") throw new TypeError("Plan conversation did not start.");
    const conversationId = String(started.state.data.conversationId);
    const saved = await operations.executePlanTransition?.({
      transitionId: "PL-T04",
      commandId: "command-2",
      conversationId,
      source: "manual",
      watts: 282,
    });
    expect(saveManual).toHaveBeenCalledWith(282);
    expect(saved).toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S062",
        data: { ftp: { usedSource: "manual", usedWatts: 282 } },
      },
    });
    await operations.executePlanTransition?.({
      transitionId: "PL-T04",
      commandId: "command-3",
      conversationId,
      source: "intervals",
      watts: null,
    });
    expect(refreshIntervals).toHaveBeenCalledOnce();
  });

  it("keeps FTP refresh failures retryable and exposes source conflicts", async () => {
    let mode: "failure" | "conflict" = "failure";
    const empty: PlanFtpSnapshot = {
      manual: null,
      intervalsFtp: null,
      intervalsEftp: null,
      usedSource: null,
      usedWatts: null,
      conflict: false,
    };
    const conflict: PlanFtpSnapshot = {
      manual: { watts: 282, refreshedAtMs: 1 },
      intervalsFtp: { watts: 278, refreshedAtMs: 2 },
      intervalsEftp: { watts: 280, refreshedAtMs: 3 },
      usedSource: "manual",
      usedWatts: 282,
      conflict: true,
    };
    const ftp: PlanFtpAdapter = {
      read: async () => (mode === "conflict" ? conflict : empty),
      saveManual: async () => empty,
      refreshIntervals: async () => {
        if (mode === "failure") throw new Error("offline");
        return conflict;
      },
    };
    const operations = createPlanningOperations(
      { context, engine: engine(), identity: identity() },
      { ftp },
    );
    const started = await operations.executePlanTransition?.({
      transitionId: "PL-T01",
      commandId: "command-1",
      sourceConversationId: null,
    });
    if (started?.status !== "completed") throw new TypeError("Plan conversation did not start.");
    const conversationId = String(started.state.data.conversationId);
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T04",
        commandId: "command-2",
        conversationId,
        source: "intervals",
        watts: null,
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { retryable: true },
      state: { scenarioId: "PL-S059", data: { ftp: { status: "refresh-failed" } } },
    });
    mode = "conflict";
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T04",
        commandId: "command-3",
        conversationId,
        source: "intervals",
        watts: null,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S060",
        data: { ftp: { status: "conflict", usedSource: "manual", usedWatts: 282 } },
      },
    });
  });

  it("requires an explicit Race Course choice and preserves it across relaunch", async () => {
    const fullCourse = course("almaty-gran-fondo.gpx");
    const routeOnly = course("route-only.gpx", "unavailable");
    const adapter: PlanRaceCourseAdapter = {
      parse: vi.fn(async (filePath) => {
        if (filePath.endsWith("invalid.gpx")) {
          return { ok: false as const, fileName: "invalid.gpx", detail: "No route found." };
        }
        return {
          ok: true as const,
          course: filePath.endsWith("route-only.gpx") ? routeOnly : fullCourse,
        };
      }),
    };
    const readiness = { isReady: () => true, course: adapter };
    const operations = createPlanningOperations(
      { context, engine: engine(), identity: identity() },
      readiness,
    );
    const started = await operations.executePlanTransition?.({
      transitionId: "PL-T01",
      commandId: "command-1",
      sourceConversationId: null,
    });
    if (started?.status !== "completed") throw new TypeError("Plan conversation did not start.");
    const conversationId = String(started.state.data.conversationId);

    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T06",
        commandId: "command-2",
        conversationId,
      }),
    ).resolves.toMatchObject({ status: "rejected" });
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T02",
        commandId: "command-3",
        conversationId,
        filePath: "/tmp/invalid.gpx",
        elevation: "require",
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      state: { scenarioId: "PL-S065", data: { course: { status: "invalid" } } },
    });
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T02",
        commandId: "command-4",
        conversationId,
        filePath: "/tmp/route-only.gpx",
        elevation: "require",
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S067",
        data: {
          course: { status: "missing-elevation", candidate: { elevationStatus: "unavailable" } },
        },
      },
    });
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T02",
        commandId: "command-5",
        conversationId,
        filePath: "/tmp/route-only.gpx",
        elevation: "allow-missing",
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S016",
        data: { readyToCreateDraft: true, course: { status: "ready" } },
      },
    });
    await expect(
      createPlanConversationRepository(store).readConversation(conversationId),
    ).resolves.toMatchObject({ courseChoiceStatus: "attached" });

    const restored = createPlanningOperations(
      { context, engine: engine(), identity: identity() },
      readiness,
    );
    await expect(restored.getPlanState?.({})).resolves.toMatchObject({
      status: "ready",
      state: {
        scenarioId: "PL-S016",
        data: { course: { status: "ready", accepted: { fileName: "route-only.gpx" } } },
      },
    });
  });

  it("keeps a failed course-omission write visible and retryable", async () => {
    const conversations = createPlanConversationRepository(store);
    const operations = createPlanningOperations(
      { context, engine: engine(), identity: identity() },
      { conversations, isReady: () => true },
    );
    const started = await operations.executePlanTransition?.({
      transitionId: "PL-T01",
      commandId: "command-1",
      sourceConversationId: null,
    });
    if (started?.status !== "completed") throw new TypeError("Plan conversation did not start.");
    const conversationId = String(started.state.data.conversationId);
    vi.spyOn(conversations, "saveConversation").mockRejectedValueOnce(new Error("disk full"));

    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T03",
        commandId: "command-2",
        conversationId,
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "persistence-failed", retryable: true },
      state: { scenarioId: "PL-S104", data: { course: { status: "omission-failed" } } },
    });
    await expect(conversations.readConversation(conversationId)).resolves.toMatchObject({
      courseChoiceStatus: "undecided",
    });
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T03",
        commandId: "command-3",
        conversationId,
      }),
    ).resolves.toMatchObject({ status: "completed", state: { scenarioId: "PL-S016" } });
  });

  it("recalculates a Draft atomically and rejects Course edits after activation", async () => {
    const firstCourse = course("almaty-gran-fondo.gpx");
    const secondCourse = course("replacement.gpx");
    const adapter: PlanRaceCourseAdapter = {
      parse: vi.fn(async (filePath) => ({
        ok: true as const,
        course: filePath.endsWith("replacement.gpx") ? secondCourse : firstCourse,
      })),
    };
    let buildRevision = 0;
    let failRecalculation = false;
    const builder: PlanDraftBuilder = {
      async form() {
        buildRevision += 1;
        return {
          plan: plan(`${"0".repeat(25)}V`, 300),
          workouts: [],
          snapshot: { completeWeeks: 12, buildRevision },
        };
      },
      async revise() {
        throw new TypeError("not used");
      },
      async recalculateCourse() {
        if (failRecalculation) throw new Error("builder unavailable");
        buildRevision += 1;
        return {
          plan: plan(`${"0".repeat(25)}V`, 301),
          workouts: [],
          snapshot: { completeWeeks: 12, buildRevision },
        };
      },
    };
    const operations = createPlanningOperations(
      { context, engine: engine(), identity: identity() },
      {
        course: adapter,
        draftBuilder: builder,
        isReady: () => true,
        todayDateKey: () => 20260709,
      },
    );
    const started = await operations.executePlanTransition?.({
      transitionId: "PL-T01",
      commandId: "command-1",
      sourceConversationId: null,
    });
    if (started?.status !== "completed") throw new TypeError("Plan conversation did not start.");
    const conversationId = String(started.state.data.conversationId);
    await operations.executePlanTransition?.({
      transitionId: "PL-T03",
      commandId: "command-2",
      conversationId,
    });
    const formed = await operations.executePlanTransition?.({
      transitionId: "PL-T06",
      commandId: "command-3",
      conversationId,
    });
    if (formed?.status !== "completed") throw new TypeError("Draft did not form.");
    const draftId = String((formed.state.data.draft as { id: string }).id);

    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T09",
        commandId: "command-4",
        draftId,
        course: { action: "attach", filePath: "/tmp/almaty-gran-fondo.gpx", elevation: "require" },
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S070",
        revision: 2,
        data: { course: { status: "ready", accepted: { fileName: "almaty-gran-fondo.gpx" } } },
      },
    });
    const latest =
      await createPlanConversationRepository(store).readLatestDraftRevision(conversationId);
    expect(latest).toMatchObject({ revision: 2 });
    expect(latest?.raceCourseJson).toContain("almaty-gran-fondo.gpx");

    failRecalculation = true;
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T09",
        commandId: "command-5",
        draftId: String(latest?.id),
        course: { action: "attach", filePath: "/tmp/replacement.gpx", elevation: "require" },
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      state: {
        scenarioId: "PL-S069",
        revision: 2,
        data: {
          course: {
            status: "recalculation-failed",
            accepted: { fileName: "almaty-gran-fondo.gpx" },
            candidate: { fileName: "replacement.gpx" },
          },
        },
      },
    });
    await expect(
      createPlanConversationRepository(store).readLatestDraftRevision(conversationId),
    ).resolves.toMatchObject({ revision: 2, raceCourseJson: latest?.raceCourseJson });

    await createPlanRepository(store).replace(
      { ...plan(`${"0".repeat(25)}V`, 302), status: "active" },
      [],
    );
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T09",
        commandId: "command-6",
        draftId: String(latest?.id),
        course: { action: "remove" },
      }),
    ).resolves.toMatchObject({ status: "rejected", error: { code: "unavailable" } });
  });

  it("recalculates a valid start date and keeps the previous Draft on invalid or failed dates", async () => {
    let failDateRecalculation = false;
    const builder: PlanDraftBuilder = {
      async form() {
        return {
          plan: plan(`${"0".repeat(25)}W`, 400),
          workouts: [],
          snapshot: { startDate: "2026-07-09" },
        };
      },
      async revise() {
        throw new TypeError("not used");
      },
      async recalculateCourse() {
        throw new TypeError("not used");
      },
      async recalculateStartDate({ preview }) {
        if (failDateRecalculation) throw new Error("generation failed");
        const current = plan(`${"0".repeat(25)}W`, 401);
        return {
          plan: {
            ...current,
            startDateKey: preview.startDateKey,
            targetDateKey: preview.targetDateKey,
            kind: preview.kind,
            totalWeeks: preview.totalWeeks,
            weekStartDay: preview.weekStartDay,
          },
          workouts: [],
          snapshot: { startDate: preview.startDateKey },
        };
      },
    };
    const operations = createPlanningOperations(
      { context, engine: engine(), identity: identity() },
      { draftBuilder: builder, isReady: () => true, todayDateKey: () => 20260709 },
    );
    const started = await operations.executePlanTransition?.({
      transitionId: "PL-T01",
      commandId: "command-1",
      sourceConversationId: null,
    });
    if (started?.status !== "completed") throw new TypeError("Plan conversation did not start.");
    const conversationId = String(started.state.data.conversationId);
    await operations.executePlanTransition?.({
      transitionId: "PL-T03",
      commandId: "command-2",
      conversationId,
    });
    const formed = await operations.executePlanTransition?.({
      transitionId: "PL-T06",
      commandId: "command-3",
      conversationId,
    });
    if (formed?.status !== "completed") throw new TypeError("Draft did not form.");
    const firstDraftId = String((formed.state.data.draft as { id: string }).id);

    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T08",
        commandId: "command-4",
        draftId: firstDraftId,
        startDate: "2026-07-08",
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "invalid-input" },
      state: {
        scenarioId: "PL-S046",
        revision: 1,
        data: { startDate: { status: "invalid", selectedDate: "2026-07-08" } },
      },
    });

    const recalculated = await operations.executePlanTransition?.({
      transitionId: "PL-T08",
      commandId: "command-5",
      draftId: firstDraftId,
      startDate: "2026-07-20",
    });
    expect(recalculated).toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S050",
        revision: 2,
        data: {
          plan: {
            startDate: "2026-07-20",
            kind: "short-race-preparation",
            totalWeeks: 11,
          },
          startDate: { status: "updated", selectedDate: "2026-07-20" },
        },
      },
    });
    if (recalculated?.status !== "completed") throw new TypeError("Draft did not recalculate.");
    const secondDraftId = String((recalculated.state.data.draft as { id: string }).id);

    failDateRecalculation = true;
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T08",
        commandId: "command-6",
        draftId: secondDraftId,
        startDate: "2026-07-21",
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "provider-failed", retryable: true },
      state: {
        scenarioId: "PL-S048",
        revision: 2,
        data: { startDate: { status: "failed", selectedDate: "2026-07-21" } },
      },
    });
    await expect(createPlanRepository(store).read(`${"0".repeat(25)}W`)).resolves.toMatchObject({
      startDateKey: 20260720,
      kind: "short_race_preparation",
    });
    await expect(
      createPlanConversationRepository(store).readLatestDraftRevision(conversationId),
    ).resolves.toMatchObject({ revision: 2 });
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
