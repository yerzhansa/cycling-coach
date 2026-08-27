import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createChatPlanOutboxRepository,
  runMigrations,
  type CreatePlanningRequestPayload,
  type MigratorStore,
  type SqlStore,
} from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { createNodeCrypto } from "../src/ingest/import-files.js";
import { openSqliteStorage } from "../src/sqlite/index.js";

const REQUEST_ID = "request-1";

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

describe("Chat Plan outbox repository", () => {
  let store: SqlStore & MigratorStore;
  let repository: ReturnType<typeof createChatPlanOutboxRepository>;

  beforeEach(async () => {
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
    repository = createChatPlanOutboxRepository(store, createNodeCrypto());
  });

  afterEach(async () => {
    await store.close();
  });

  it("persists one pending request before delivery and returns it for an identical retry", async () => {
    const created = await repository.createOrGet({ payload: payload(), createdAtMs: 100 });
    const retried = await repository.createOrGet({ payload: payload(), createdAtMs: 999 });

    expect(retried).toEqual(created);
    expect(created).toMatchObject({
      requestId: REQUEST_ID,
      state: "pending",
      attemptCount: 0,
      createdAtMs: 100,
      updatedAtMs: 100,
      payload: { requestId: REQUEST_ID },
    });
    expect(created.payloadHash).toMatch(/^[0-9a-f]{64}$/u);
    await expect(store.get("SELECT count(*) AS count FROM chat_plan_outbox")).resolves.toEqual({
      count: 1,
    });
  });

  it("rejects a changed payload under the same request identifier", async () => {
    await repository.createOrGet({ payload: payload(), createdAtMs: 100 });

    await expect(
      repository.createOrGet({
        payload: payload({ intent: "Replace Tuesday instead." }),
        createdAtMs: 101,
      }),
    ).rejects.toMatchObject({ code: "request-conflict" });
    await expect(store.get("SELECT count(*) AS count FROM chat_plan_outbox")).resolves.toEqual({
      count: 1,
    });
  });

  it("persists attempts and retries the same request through failure to delivery", async () => {
    await repository.createOrGet({ payload: payload(), createdAtMs: 100 });
    await expect(
      repository.beginDelivery({ requestId: REQUEST_ID, attemptedAtMs: 110 }),
    ).resolves.toMatchObject({ state: "pending", attemptCount: 1, updatedAtMs: 110 });
    await expect(
      repository.markFailed({
        requestId: REQUEST_ID,
        failureCode: "planning_unavailable",
        retryable: true,
        failedAtMs: 120,
      }),
    ).resolves.toMatchObject({
      state: "failed",
      attemptCount: 1,
      failureCode: "planning_unavailable",
      retryable: true,
    });
    await expect(
      repository.beginDelivery({ requestId: REQUEST_ID, attemptedAtMs: 130 }),
    ).resolves.toMatchObject({ state: "pending", attemptCount: 2, updatedAtMs: 130 });
    const delivered = await repository.markDelivered({
      requestId: REQUEST_ID,
      deliveredAtMs: 140,
    });
    expect(delivered).toMatchObject({
      state: "delivered",
      attemptCount: 2,
      deliveredAtMs: 140,
      sourceDeletedAtMs: null,
    });
    await expect(
      repository.markDelivered({ requestId: REQUEST_ID, deliveredAtMs: 999 }),
    ).resolves.toEqual(delivered);
    await expect(repository.readRecoverable()).resolves.toEqual([]);
  });

  it("does not retry a failure marked non-retryable", async () => {
    await repository.createOrGet({ payload: payload(), createdAtMs: 100 });
    await repository.beginDelivery({ requestId: REQUEST_ID, attemptedAtMs: 110 });
    await repository.markFailed({
      requestId: REQUEST_ID,
      failureCode: "request_conflict",
      retryable: false,
      failedAtMs: 120,
    });

    await expect(
      repository.beginDelivery({ requestId: REQUEST_ID, attemptedAtMs: 130 }),
    ).rejects.toMatchObject({ code: "non-retryable" });
    await expect(repository.readRecoverable()).resolves.toEqual([]);
  });

  it("returns pending and retryable failed records in stable recovery order", async () => {
    await repository.createOrGet({
      payload: payload({ requestId: "request-1" }),
      createdAtMs: 100,
    });
    await repository.createOrGet({
      payload: payload({ requestId: "request-2" }),
      createdAtMs: 101,
    });
    await repository.beginDelivery({ requestId: "request-2", attemptedAtMs: 102 });
    await repository.markFailed({
      requestId: "request-2",
      failureCode: "planning_unavailable",
      retryable: true,
      failedAtMs: 103,
    });
    await repository.createOrGet({
      payload: payload({ requestId: "request-3" }),
      createdAtMs: 104,
    });
    await repository.beginDelivery({ requestId: "request-3", attemptedAtMs: 105 });
    await repository.markFailed({
      requestId: "request-3",
      failureCode: "request_conflict",
      retryable: false,
      failedAtMs: 106,
    });

    const recoverable = await repository.readRecoverable();
    expect(recoverable.map(({ requestId }) => requestId)).toEqual(["request-1", "request-2"]);
  });

  it("cancels an undelivered source and makes its payload irrecoverable", async () => {
    await repository.createOrGet({ payload: payload(), createdAtMs: 100 });
    await repository.beginDelivery({ requestId: REQUEST_ID, attemptedAtMs: 110 });
    await repository.markFailed({
      requestId: REQUEST_ID,
      failureCode: "planning_unavailable",
      retryable: true,
      failedAtMs: 120,
    });
    const cancelled = await repository.cancelUndelivered({
      requestId: REQUEST_ID,
      cancelledAtMs: 130,
    });

    expect(cancelled).toMatchObject({
      state: "cancelled",
      payload: null,
      cancelledAtMs: 130,
      cancelReason: "source_conversation_deleted",
    });
    await expect(
      repository.cancelUndelivered({ requestId: REQUEST_ID, cancelledAtMs: 999 }),
    ).resolves.toEqual(cancelled);
    await expect(
      repository.beginDelivery({ requestId: REQUEST_ID, attemptedAtMs: 140 }),
    ).rejects.toMatchObject({ code: "invalid-transition" });
    await expect(
      store.run("UPDATE chat_plan_outbox SET updated_at_ms = 999 WHERE request_id = ?", [
        REQUEST_ID,
      ]),
    ).rejects.toThrow();
    await expect(
      store.run("DELETE FROM chat_plan_outbox WHERE request_id = ?", [REQUEST_ID]),
    ).rejects.toThrow();
  });

  it("compacts a delivered source only after delivery and keeps its payload hash", async () => {
    await repository.createOrGet({ payload: payload(), createdAtMs: 100 });
    await expect(
      repository.detachDeliveredSource({ requestId: REQUEST_ID, sourceDeletedAtMs: 105 }),
    ).rejects.toMatchObject({ code: "invalid-transition" });
    await repository.beginDelivery({ requestId: REQUEST_ID, attemptedAtMs: 110 });
    const delivered = await repository.markDelivered({
      requestId: REQUEST_ID,
      deliveredAtMs: 120,
    });
    const detached = await repository.detachDeliveredSource({
      requestId: REQUEST_ID,
      sourceDeletedAtMs: 130,
    });

    expect(detached).toMatchObject({
      state: "delivered",
      payload: null,
      deliveredAtMs: 120,
      sourceDeletedAtMs: 130,
      payloadHash: delivered.payloadHash,
    });
    await expect(repository.createOrGet({ payload: payload(), createdAtMs: 999 })).resolves.toEqual(
      detached,
    );
    await expect(
      store.run("UPDATE chat_plan_outbox SET updated_at_ms = 999 WHERE request_id = ?", [
        REQUEST_ID,
      ]),
    ).rejects.toThrow();
  });

  it("rejects delivery before an attempt and detects a corrupted payload hash", async () => {
    await repository.createOrGet({ payload: payload(), createdAtMs: 100 });
    await expect(
      repository.markDelivered({ requestId: REQUEST_ID, deliveredAtMs: 110 }),
    ).rejects.toMatchObject({ code: "invalid-transition" });
    await expect(
      repository.markFailed({
        requestId: REQUEST_ID,
        failureCode: "planning_unavailable",
        retryable: true,
        failedAtMs: 110,
      }),
    ).rejects.toMatchObject({ code: "invalid-transition" });
    await store.run("UPDATE chat_plan_outbox SET payload_hash = ? WHERE request_id = ?", [
      "b".repeat(64),
      REQUEST_ID,
    ]);
    await expect(repository.read(REQUEST_ID)).rejects.toMatchObject({ code: "corrupt-record" });
  });
});
