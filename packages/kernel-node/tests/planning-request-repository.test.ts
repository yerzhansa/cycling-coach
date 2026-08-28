import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalizeCreatePlanningRequestPayload,
  createPlanConversationRepository,
  createPlanProposalRepository,
  createPlanningRequestRepository,
  createPlanRepository,
  hashCreatePlanningRequestPayload,
  PlanningRequestStoreError,
  type CreatePlanningRequestInput,
  type CreatePlanningRequestPayload,
  type PlanConversationRecord,
  type PlanProposalRecord,
  type PlanProposalPremiseRecord,
  type PlanRecord,
  type PlanningRequestProvenanceSnapshot,
  type PlanningRequestTerminalResult,
} from "@enduragent/kernel/planning";
import { runMigrations, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { createNodeCrypto } from "../src/ingest/import-files.js";
import { openSqliteStorage } from "../src/sqlite/index.js";

const id = (suffix: string): string => `${"0".repeat(26 - suffix.length)}${suffix}`;
const REQUEST_ID = id("1");
const PLAN_ID = id("2");
const CONVERSATION_ID = id("3");
const PROPOSAL_ID = id("4");
const PREMISE_ID = id("5");

function payload(
  overrides: Partial<CreatePlanningRequestPayload> = {},
): CreatePlanningRequestPayload {
  return {
    requestId: REQUEST_ID,
    kind: "workout_review",
    intent: "Review this workout before I add it to my Plan.",
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
          segments: [],
        },
      },
    },
    requestedDate: "1998-08-26",
    ...overrides,
  };
}

function createInput(
  overrides: Partial<CreatePlanningRequestInput> = {},
): CreatePlanningRequestInput {
  return {
    payload: payload(),
    target: "active_plan",
    createdAtMs: 100,
    deviceId: "device-1",
    hlcPhysicalMs: 100,
    hlcCounter: 0,
    ...overrides,
  };
}

function provenance(requestId = REQUEST_ID): PlanningRequestProvenanceSnapshot {
  return {
    requestId,
    kind: "workout_review",
    intentSummary: "Review Tempo 3 × 12 before adding it to the Plan.",
    source: {
      chatId: "chat-1",
      messageId: "message-1",
      sourceDeleted: true,
    },
    attachment: {
      attachmentId: "attachment-1",
      displayName: "tempo-3x12.mrc",
      extension: "mrc",
    },
    workout: {
      setId: "set-1",
      workoutId: "workout-1",
      name: "Tempo 3 × 12",
      sport: "cycling",
      durationSeconds: 3_840,
    },
    capturedAt: "1998-08-24T08:00:00.000Z",
  };
}

function terminal(
  overrides: Partial<Extract<PlanningRequestTerminalResult, { kind: "applied" }>> = {},
): Extract<PlanningRequestTerminalResult, { kind: "applied" }> {
  return {
    kind: "applied",
    resultId: "result-1",
    completedAtMs: 300,
    title: "Workout added",
    detail: "Tempo 3 × 12 is scheduled for Wednesday.",
    workoutRef: { setId: "set-1", workoutId: "workout-1" },
    planRevisionId: "plan-revision-1",
    ...overrides,
  };
}

function plan(): PlanRecord {
  return {
    id: PLAN_ID,
    originId: null,
    name: "Autumn base",
    primaryGoal: "Build consistency",
    startDateKey: 19980824,
    targetDateKey: null,
    status: "active",
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

function conversation(): PlanConversationRecord {
  return {
    id: CONVERSATION_ID,
    planId: PLAN_ID,
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

function proposal(): PlanProposalRecord {
  return {
    id: PROPOSAL_ID,
    planId: PLAN_ID,
    parentProposalId: null,
    revision: 1,
    status: "proposed",
    title: "Schedule Tempo 3 × 12",
    rationale: "Wednesday has no existing workout.",
    confidence: "High",
    mutationJson: '{"changes":[],"schemaVersion":1,"weekLoad":null}',
    baseSnapshotJson: '{"planUpdatedAtMs":10,"schemaVersion":1,"workouts":[]}',
    refusalReason: null,
    createdAtMs: 30,
    updatedAtMs: 30,
    resolvedAtMs: null,
    deviceId: "device-1",
    hlcPhysicalMs: 30,
    hlcCounter: 0,
  };
}

function premise(): PlanProposalPremiseRecord {
  return {
    id: PREMISE_ID,
    proposalId: PROPOSAL_ID,
    sourceType: "workout",
    sourceId: "workout-1",
    sourceLabel: "Tempo 3 × 12",
    sourceDateKey: 19980826,
    confidence: "High",
    snapshotJson: '{"durationSeconds":3840}',
    createdAtMs: 30,
    deviceId: "device-1",
    hlcPhysicalMs: 30,
    hlcCounter: 0,
  };
}

describe("Planning request repository", () => {
  let store: SqlStore & MigratorStore;
  let repository: ReturnType<typeof createPlanningRequestRepository>;

  beforeEach(async () => {
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
    repository = createPlanningRequestRepository(store, createNodeCrypto());
  });

  afterEach(async () => {
    await store.close();
  });

  it("creates one durable open request and returns it for an identical retry", async () => {
    const created = await repository.createOrGet(createInput());
    const retried = await repository.createOrGet(
      createInput({ target: "draft", createdAtMs: 999, hlcPhysicalMs: 999 }),
    );

    expect(created).toEqual(retried);
    expect(created.request).toMatchObject({
      requestId: REQUEST_ID,
      target: "active_plan",
      lifecycle: "open",
      attention: "none",
      revision: 1,
      requestedDateKey: 19980826,
      source: { chatId: "chat-1", messageId: "message-1", available: true },
      terminalResult: null,
    });
    expect(created.payloadHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(created.sourceState).toMatchObject({ status: "linked", provenance: null });
    expect(await repository.readOpen()).toEqual([created]);
    await expect(store.get("SELECT count(*) AS count FROM planning_request")).resolves.toEqual({
      count: 1,
    });
  });

  it("canonicalizes and hashes payloads independently of object key order", async () => {
    const original = payload();
    const reordered = {
      requestedDate: original.requestedDate,
      sourceSnapshot: original.sourceSnapshot,
      source: original.source,
      intent: original.intent,
      kind: original.kind,
      requestId: original.requestId,
    };

    expect(canonicalizeCreatePlanningRequestPayload(reordered)).toBe(
      canonicalizeCreatePlanningRequestPayload(original),
    );
    await expect(hashCreatePlanningRequestPayload(createNodeCrypto(), reordered)).resolves.toBe(
      await hashCreatePlanningRequestPayload(createNodeCrypto(), original),
    );
  });

  it("rejects a different payload under the same request identifier", async () => {
    await repository.createOrGet(createInput());
    await expect(
      repository.createOrGet(
        createInput({ payload: payload({ intent: "Use a different date." }) }),
      ),
    ).rejects.toEqual(new PlanningRequestStoreError("request-conflict"));
    await expect(store.get("SELECT count(*) AS count FROM planning_request")).resolves.toEqual({
      count: 1,
    });
  });

  it("rejects an invalid workout-review payload before writing", async () => {
    await expect(
      repository.createOrGet(
        createInput({
          payload: payload({
            source: { chatId: "chat-1", messageId: "message-1" },
          }),
        }),
      ),
    ).rejects.toEqual(new PlanningRequestStoreError("invalid-create"));
    await expect(repository.read(REQUEST_ID)).resolves.toBeUndefined();
  });

  it("binds the Plan conversation, Proposal, and attention with optimistic revision", async () => {
    await createPlanRepository(store).replace(plan(), []);
    await createPlanConversationRepository(store).saveConversation(conversation());
    await createPlanProposalRepository(store).save(proposal(), [premise()]);
    await repository.createOrGet(createInput());

    const revised = await repository.reviseOpen({
      requestId: REQUEST_ID,
      expectedRevision: 1,
      planConversationId: CONVERSATION_ID,
      proposalId: PROPOSAL_ID,
      attention: "needs_review",
      resolvedDateKey: 19980826,
      updatedAtMs: 200,
      deviceId: "device-1",
      hlcPhysicalMs: 200,
      hlcCounter: 0,
    });

    expect(revised.request).toMatchObject({
      planConversationId: CONVERSATION_ID,
      proposalId: PROPOSAL_ID,
      attention: "needs_review",
      resolvedDateKey: 19980826,
      revision: 2,
    });
    await expect(
      repository.reviseOpen({
        requestId: REQUEST_ID,
        expectedRevision: 1,
        planConversationId: CONVERSATION_ID,
        proposalId: PROPOSAL_ID,
        attention: "needs_review",
        resolvedDateKey: 19980826,
        updatedAtMs: 201,
        deviceId: "device-1",
        hlcPhysicalMs: 201,
        hlcCounter: 0,
      }),
    ).rejects.toEqual(new PlanningRequestStoreError("stale-revision"));
  });

  it("commits one immutable terminal result and tombstone", async () => {
    await repository.createOrGet(createInput());
    const completed = await repository.complete({
      requestId: REQUEST_ID,
      expectedRevision: 1,
      result: terminal(),
      resolvedDateKey: 19980826,
      updatedAtMs: 300,
      deviceId: "device-1",
      hlcPhysicalMs: 300,
      hlcCounter: 0,
    });

    expect(completed.request).toMatchObject({
      lifecycle: "applied",
      attention: "none",
      revision: 2,
      terminalResult: terminal(),
    });
    expect(completed.tombstone).toEqual({
      requestId: REQUEST_ID,
      payloadHash: completed.payloadHash,
      status: "applied",
      createdAtMs: 300,
      terminalAtMs: 300,
    });
    await expect(
      repository.complete({
        requestId: REQUEST_ID,
        expectedRevision: 1,
        result: terminal(),
        resolvedDateKey: 19980826,
        updatedAtMs: 300,
        deviceId: "device-1",
        hlcPhysicalMs: 300,
        hlcCounter: 0,
      }),
    ).resolves.toEqual(completed);
    await expect(
      repository.complete({
        requestId: REQUEST_ID,
        expectedRevision: 2,
        result: terminal({ detail: "Different terminal content." }),
        resolvedDateKey: 19980826,
        updatedAtMs: 301,
        deviceId: "device-1",
        hlcPhysicalMs: 301,
        hlcCounter: 0,
      }),
    ).rejects.toEqual(new PlanningRequestStoreError("immutable-terminal"));
    await expect(
      store.run("UPDATE planning_request_terminal_result SET result_id = ? WHERE request_id = ?", [
        "other-result",
        REQUEST_ID,
      ]),
    ).rejects.toThrow(/immutable/u);
  });

  it("detaches an open source without losing the payload", async () => {
    await repository.createOrGet(createInput());
    const detached = await repository.detachSource({
      requestId: REQUEST_ID,
      expectedRevision: 1,
      provenance: provenance(),
      updatedAtMs: 200,
      deviceId: "device-1",
      hlcPhysicalMs: 200,
      hlcCounter: 0,
    });

    expect(detached.request.source.available).toBe(false);
    expect(detached.sourceState).toMatchObject({
      status: "detached_open",
      payload: payload(),
      provenance: provenance(),
    });
    expect(detached.tombstone).toEqual({
      requestId: REQUEST_ID,
      payloadHash: detached.payloadHash,
      status: "source_deleted",
      createdAtMs: 200,
      terminalAtMs: null,
    });
    await expect(
      repository.compactSource({
        requestId: REQUEST_ID,
        expectedRevision: 2,
        updatedAtMs: 201,
        deviceId: "device-1",
        hlcPhysicalMs: 201,
        hlcCounter: 0,
      }),
    ).rejects.toEqual(new PlanningRequestStoreError("invalid-transition"));
  });

  it("compacts only a terminal detached source and retains safe provenance", async () => {
    await repository.createOrGet(createInput());
    await repository.complete({
      requestId: REQUEST_ID,
      expectedRevision: 1,
      result: terminal(),
      resolvedDateKey: 19980826,
      updatedAtMs: 300,
      deviceId: "device-1",
      hlcPhysicalMs: 300,
      hlcCounter: 0,
    });
    await repository.detachSource({
      requestId: REQUEST_ID,
      expectedRevision: 2,
      provenance: provenance(),
      updatedAtMs: 400,
      deviceId: "device-1",
      hlcPhysicalMs: 400,
      hlcCounter: 0,
    });
    const compacted = await repository.compactSource({
      requestId: REQUEST_ID,
      expectedRevision: 3,
      updatedAtMs: 500,
      deviceId: "device-1",
      hlcPhysicalMs: 500,
      hlcCounter: 0,
    });

    expect(compacted.sourceState).toEqual({
      status: "compacted",
      identity: {
        chatId: "chat-1",
        messageId: "message-1",
        attachmentId: "attachment-1",
      },
      payload: null,
      provenance: provenance(),
    });
    expect(compacted.request.lifecycle).toBe("applied");
    expect(compacted.request.terminalResult).toEqual(terminal());
    expect(compacted.tombstone?.status).toBe("applied");
  });

  it("compacts an already detached source in the terminal commit", async () => {
    await repository.createOrGet(createInput());
    await repository.detachSource({
      requestId: REQUEST_ID,
      expectedRevision: 1,
      provenance: provenance(),
      updatedAtMs: 200,
      deviceId: "device-1",
      hlcPhysicalMs: 200,
      hlcCounter: 0,
    });

    const completed = await repository.complete({
      requestId: REQUEST_ID,
      expectedRevision: 2,
      result: terminal(),
      resolvedDateKey: 19980826,
      updatedAtMs: 300,
      deviceId: "device-1",
      hlcPhysicalMs: 300,
      hlcCounter: 0,
    });

    expect(completed.request.revision).toBe(3);
    expect(completed.request.lifecycle).toBe("applied");
    expect(completed.sourceState).toEqual({
      status: "compacted",
      identity: {
        chatId: "chat-1",
        messageId: "message-1",
        attachmentId: "attachment-1",
      },
      payload: null,
      provenance: provenance(),
    });
  });
});
