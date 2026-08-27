import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CreatePlanningRequestPayload } from "@enduragent/coach-contract";
import {
  createPlanningRequestRepository,
  createPlanRepository,
  type PlanRecord,
} from "@enduragent/kernel/planning";
import {
  createChatPlanOutboxRepository,
  runMigrations,
  type MigratorStore,
  type SqlStore,
} from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { createNodeCrypto } from "@enduragent/kernel-node/ingest";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import type { AuthoredIdentity } from "@enduragent/kernel-node/home";
import {
  createPlanningRequestDeliveryService,
  type PlanningRequestDeliveryServiceDependencies,
} from "../src/planning-request-delivery.js";

const PLAN_ID = "01J60HFQ7T0000000000000000";

function requestPayload(
  overrides: Partial<CreatePlanningRequestPayload> = {},
): CreatePlanningRequestPayload {
  return {
    requestId: "request-1",
    kind: "workout_review",
    intent: "Review this Workout before I add it to my Plan.",
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
        workout: { name: "Tempo 3 × 12", sport: "cycling", durationSeconds: 3_840 },
      },
    },
    requestedDate: "1998-08-26",
    ...overrides,
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

describe("Planning request delivery", () => {
  let store: SqlStore & MigratorStore;
  let instant: number;
  let identity: AuthoredIdentity;

  beforeEach(async () => {
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
    instant = 100;
    identity = {
      deviceId: async () => "device-1",
      newUlid: () => "01J60HFQ7T0000000000000001",
      hlcStamp: () => ({ physicalMs: instant++, counter: 0 }),
    };
  });

  afterEach(async () => store.close());

  const service = (
    afterPlanningAccepted?: PlanningRequestDeliveryServiceDependencies["afterPlanningAccepted"],
  ) => {
    const crypto = createNodeCrypto();
    const plans = createPlanRepository(store);
    return createPlanningRequestDeliveryService(
      {
        outbox: createChatPlanOutboxRepository(store, crypto),
        requests: createPlanningRequestRepository(store, crypto),
        identity,
        async resolveTarget() {
          const latest = await plans.readLatest();
          if (latest?.status === "active") return "active_plan";
          if (latest?.status === "draft") return "draft";
          return "plan_creation";
        },
      },
      { afterPlanningAccepted },
    );
  };

  it.each([
    ["active", "active_plan"],
    ["draft", "draft"],
    ["ended", "plan_creation"],
  ] as const)("routes a %s Plan to %s", async (status, target) => {
    await createPlanRepository(store).replace(plan(status), []);
    const result = await service().createPlanningRequest!({ payload: requestPayload() });
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") throw new TypeError();
    expect(result.delivery).toMatchObject({
      state: "delivered",
      attemptCount: 1,
      retryable: false,
      planningRequest: { target },
    });
  });

  it("routes to Plan creation when no Plan exists", async () => {
    const result = await service().createPlanningRequest!({ payload: requestPayload() });
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") throw new TypeError();
    expect(result.delivery.planningRequest?.target).toBe("plan_creation");
  });

  it("retries the same request after Planning accepted before Chat acknowledged", async () => {
    await expect(
      service(() => {
        throw new Error("synthetic process interruption");
      }).createPlanningRequest!({ payload: requestPayload() }),
    ).rejects.toThrow("synthetic process interruption");

    const before = await service().getPlanningRequest!({ requestId: "request-1" });
    expect(before).toMatchObject({
      status: "found",
      delivery: { state: "pending", attemptCount: 1, planningRequest: { requestId: "request-1" } },
    });

    const retried = await service().retryPlanningRequest!({ requestId: "request-1" });
    expect(retried).toMatchObject({
      status: "found",
      delivery: { state: "delivered", attemptCount: 2, planningRequest: { requestId: "request-1" } },
    });
    expect(await createPlanningRequestRepository(store, createNodeCrypto()).readOpen()).toHaveLength(
      1,
    );
  });

  it("resumes persisted pending delivery and rejects conflicting reuse", async () => {
    const crypto = createNodeCrypto();
    await createChatPlanOutboxRepository(store, crypto).createOrGet({
      payload: requestPayload(),
      createdAtMs: instant++,
    });
    const resumed = await service().resumePlanningRequests!({});
    expect(resumed.deliveries).toHaveLength(1);
    expect(resumed.deliveries[0]).toMatchObject({ state: "delivered", attemptCount: 1 });

    await expect(
      service().createPlanningRequest!({
        payload: requestPayload({ intent: "Use a different intent under the same identifier." }),
      }),
    ).resolves.toEqual({ status: "rejected", reason: "request_conflict" });
  });

  it("records a non-retryable failure when Planning owns a conflicting payload", async () => {
    const crypto = createNodeCrypto();
    await createPlanningRequestRepository(store, crypto).createOrGet({
      payload: requestPayload({ intent: "The payload Planning accepted first." }),
      target: "plan_creation",
      createdAtMs: 90,
      deviceId: "device-1",
      hlcPhysicalMs: 90,
      hlcCounter: 0,
    });

    const result = await service().createPlanningRequest!({ payload: requestPayload() });
    expect(result).toMatchObject({
      status: "accepted",
      delivery: {
        state: "failed",
        failureCode: "request_conflict",
        retryable: false,
        planningRequest: null,
      },
    });
  });
});
