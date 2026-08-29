import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CreatePlanningRequestPayload } from "@enduragent/coach-contract";
import {
  createPlanningRequestRepository,
  type PlanningRequestTerminalResult,
} from "@enduragent/kernel/planning";
import {
  createChatPlanOutboxRepository,
  runMigrations,
  type MigratorStore,
  type SqlStore,
} from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { createNodeCrypto } from "@enduragent/kernel-node/ingest";
import type { AuthoredIdentity } from "@enduragent/kernel-node/home";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { createPlanningRequestSourceCleanup } from "../src/planning-request-source-cleanup.js";

function payload(
  requestId: string,
  messageId: string,
  overrides: Partial<CreatePlanningRequestPayload> = {},
): CreatePlanningRequestPayload {
  return {
    requestId,
    kind: "workout_review",
    intent: "  Review Tempo 3 × 12 before adding it to the Plan.  ",
    source: {
      chatId: "chat-1",
      messageId,
      attachmentId: `attachment-${requestId}`,
    },
    sourceSnapshot: {
      capturedAt: "1998-08-24T08:00:00.000Z",
      attachment: {
        attachmentId: `attachment-${requestId}`,
        displayName: "tempo-3x12.mrc",
        extension: "mrc",
      },
      selectedWorkout: {
        setId: `set-${requestId}`,
        workoutId: `workout-${requestId}`,
        workout: {
          title: "Tempo 3 × 12",
          sport: "cycling",
          durationSeconds: 3_840,
          segments: [],
        },
      },
    },
    ...overrides,
  };
}

function terminal(requestId: string): PlanningRequestTerminalResult {
  return {
    kind: "applied",
    resultId: `result-${requestId}`,
    completedAtMs: 180,
    title: "Workout added",
    detail: "Tempo 3 × 12 was added to Wednesday.",
    workoutRef: {
      setId: `set-${requestId}`,
      workoutId: `workout-${requestId}`,
    },
    planRevisionId: `revision-${requestId}`,
  };
}

describe("Planning request source cleanup", () => {
  let store: SqlStore & MigratorStore;
  let instant: number;
  let identity: AuthoredIdentity;

  beforeEach(async () => {
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
    instant = 200;
    identity = {
      deviceId: async () => "device-1",
      newUlid: () => "01J60HFQ7T0000000000000001",
      hlcStamp: () => ({ physicalMs: instant++, counter: 0 }),
    };
  });

  afterEach(async () => store.close());

  it("cancels undelivered sources and preserves delivered Plan truth", async () => {
    const crypto = createNodeCrypto();
    const outbox = createChatPlanOutboxRepository(store, crypto);
    const requests = createPlanningRequestRepository(store, crypto);
    const pendingPayload = payload("pending", "message-pending");
    const failedPayload = payload("failed", "message-failed");
    const openPayload = payload("open", "message-open");
    const terminalPayload = payload("terminal", "message-terminal");

    await outbox.createOrGet({ payload: pendingPayload, createdAtMs: 100 });
    await outbox.createOrGet({ payload: failedPayload, createdAtMs: 101 });
    await outbox.beginDelivery({ requestId: "failed", attemptedAtMs: 102 });
    await outbox.markFailed({
      requestId: "failed",
      failureCode: "planning_unavailable",
      retryable: true,
      failedAtMs: 103,
    });

    for (const [createdAtMs, requestPayload] of [
      [104, openPayload],
      [108, terminalPayload],
    ] as const) {
      await outbox.createOrGet({ payload: requestPayload, createdAtMs });
      await outbox.beginDelivery({
        requestId: requestPayload.requestId,
        attemptedAtMs: createdAtMs + 1,
      });
      await requests.createOrGet({
        payload: requestPayload,
        target: "active_plan",
        createdAtMs: createdAtMs + 2,
        deviceId: "device-1",
        hlcPhysicalMs: createdAtMs + 2,
        hlcCounter: 0,
      });
      await outbox.markDelivered({
        requestId: requestPayload.requestId,
        deliveredAtMs: createdAtMs + 3,
      });
    }
    await requests.complete({
      requestId: "terminal",
      expectedRevision: 1,
      result: terminal("terminal"),
      resolvedDateKey: 19980826,
      updatedAtMs: 190,
      deviceId: "device-1",
      hlcPhysicalMs: 190,
      hlcCounter: 0,
    });

    await createPlanningRequestSourceCleanup({ outbox, requests, identity })("chat-1");

    await expect(outbox.read("pending")).resolves.toMatchObject({
      state: "cancelled",
      payload: null,
      cancelReason: "source_conversation_deleted",
    });
    await expect(outbox.read("failed")).resolves.toMatchObject({
      state: "cancelled",
      payload: null,
      cancelReason: "source_conversation_deleted",
    });
    await expect(outbox.read("open")).resolves.toMatchObject({
      state: "delivered",
      payload: null,
      sourceDeletedAtMs: expect.any(Number),
    });
    await expect(requests.read("open")).resolves.toMatchObject({
      request: { lifecycle: "open", source: { available: false } },
      sourceState: {
        status: "detached_open",
        payload: openPayload,
        provenance: {
          intentSummary: "Review Tempo 3 × 12 before adding it to the Plan.",
          source: { sourceDeleted: true },
          attachment: { displayName: "tempo-3x12.mrc" },
          workout: {
            name: "Tempo 3 × 12",
            sport: "cycling",
            durationSeconds: 3_840,
          },
        },
      },
    });
    await expect(requests.read("terminal")).resolves.toMatchObject({
      request: { lifecycle: "applied", source: { available: false } },
      sourceState: {
        status: "compacted",
        payload: null,
        provenance: { source: { sourceDeleted: true } },
      },
      tombstone: { status: "applied" },
    });
  });

  it("is idempotent after a delivered source was detached", async () => {
    const crypto = createNodeCrypto();
    const outbox = createChatPlanOutboxRepository(store, crypto);
    const requests = createPlanningRequestRepository(store, crypto);
    const requestPayload = payload("open", "message-open");
    await outbox.createOrGet({ payload: requestPayload, createdAtMs: 100 });
    await outbox.beginDelivery({ requestId: "open", attemptedAtMs: 101 });
    await requests.createOrGet({
      payload: requestPayload,
      target: "active_plan",
      createdAtMs: 102,
      deviceId: "device-1",
      hlcPhysicalMs: 102,
      hlcCounter: 0,
    });
    await outbox.markDelivered({ requestId: "open", deliveredAtMs: 103 });
    const cleanup = createPlanningRequestSourceCleanup({ outbox, requests, identity });

    await cleanup("chat-1");
    await expect(cleanup("chat-1")).resolves.toBeUndefined();
    await expect(requests.read("open")).resolves.toMatchObject({
      request: { revision: 2 },
      sourceState: { status: "detached_open" },
    });
  });

  it("cleans only sources selected by archived turn or attachment", async () => {
    const crypto = createNodeCrypto();
    const outbox = createChatPlanOutboxRepository(store, crypto);
    const requests = createPlanningRequestRepository(store, crypto);
    const selectedPending = payload("selected-pending", "turn-selected");
    const unrelatedPending = payload("unrelated-pending", "turn-retained");
    const selectedDelivered = payload("selected-delivered", "message-not-selected", {
      source: {
        chatId: "chat-1",
        messageId: "message-not-selected",
        attachmentId: "attachment-selected",
      },
      sourceSnapshot: {
        ...payload("selected-delivered", "message-not-selected").sourceSnapshot,
        attachment: {
          attachmentId: "attachment-selected",
          displayName: "tempo-3x12.mrc",
          extension: "mrc",
        },
      },
    });
    const unrelatedDelivered = payload("unrelated-delivered", "message-retained");

    await outbox.createOrGet({ payload: selectedPending, createdAtMs: 100 });
    await outbox.createOrGet({ payload: unrelatedPending, createdAtMs: 101 });
    for (const [createdAtMs, requestPayload] of [
      [102, selectedDelivered],
      [106, unrelatedDelivered],
    ] as const) {
      await outbox.createOrGet({ payload: requestPayload, createdAtMs });
      await outbox.beginDelivery({
        requestId: requestPayload.requestId,
        attemptedAtMs: createdAtMs + 1,
      });
      await requests.createOrGet({
        payload: requestPayload,
        target: "active_plan",
        createdAtMs: createdAtMs + 2,
        deviceId: "device-1",
        hlcPhysicalMs: createdAtMs + 2,
        hlcCounter: 0,
      });
      await outbox.markDelivered({
        requestId: requestPayload.requestId,
        deliveredAtMs: createdAtMs + 3,
      });
    }

    const cleanup = createPlanningRequestSourceCleanup({ outbox, requests, identity });
    await cleanup("chat-1", {
      messageIds: ["turn-selected"],
      attachmentIds: ["attachment-selected"],
    });

    await expect(outbox.read("selected-pending")).resolves.toMatchObject({
      state: "cancelled",
      payload: null,
    });
    await expect(outbox.read("unrelated-pending")).resolves.toMatchObject({
      state: "pending",
      payload: unrelatedPending,
    });
    await expect(outbox.read("selected-delivered")).resolves.toMatchObject({
      state: "delivered",
      payload: null,
    });
    await expect(requests.read("selected-delivered")).resolves.toMatchObject({
      sourceState: { status: "detached_open" },
    });
    await expect(outbox.read("unrelated-delivered")).resolves.toMatchObject({
      state: "delivered",
      payload: unrelatedDelivered,
      sourceDeletedAtMs: null,
    });
    await expect(requests.read("unrelated-delivered")).resolves.toMatchObject({
      sourceState: { status: "linked" },
    });
  });
});
