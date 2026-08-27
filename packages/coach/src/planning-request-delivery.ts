import {
  CreatePlanningRequestRpcParamsSchema,
  CreatePlanningRequestRpcResultSchema,
  GetPlanningRequestRpcParamsSchema,
  GetPlanningRequestRpcResultSchema,
  PlanningRequestDeliverySchema,
  ResumePlanningRequestsRpcParamsSchema,
  ResumePlanningRequestsRpcResultSchema,
  RetryPlanningRequestRpcParamsSchema,
  RetryPlanningRequestRpcResultSchema,
  type PlanningRequestDelivery,
  type PlanningRequestOperations,
} from "@enduragent/coach-contract";
import {
  PlanningRequestStoreError,
  type PlanningRequestRecord,
  type PlanningRequestRepository,
  type PlanningRequestTarget,
} from "@enduragent/kernel/planning";
import {
  ChatPlanOutboxStoreError,
  type ChatPlanOutboxRecord,
  type ChatPlanOutboxRepository,
} from "@enduragent/kernel/store";
import type { AuthoredIdentity } from "@enduragent/kernel-node/home";

export interface PlanningRequestDeliveryServiceInput {
  readonly outbox: ChatPlanOutboxRepository;
  readonly requests: PlanningRequestRepository;
  readonly identity: AuthoredIdentity;
  readonly resolveTarget: () => Promise<PlanningRequestTarget>;
}

export interface PlanningRequestDeliveryServiceDependencies {
  readonly afterPlanningAccepted?: (request: PlanningRequestRecord) => void | Promise<void>;
}

function retryable(record: ChatPlanOutboxRecord): boolean {
  return record.state === "pending" || (record.state === "failed" && record.retryable);
}

async function project(
  requests: PlanningRequestRepository,
  record: ChatPlanOutboxRecord,
): Promise<PlanningRequestDelivery> {
  const planningRecord = await requests.read(record.requestId);
  const matchedPlanningRecord =
    planningRecord?.payloadHash === record.payloadHash ? planningRecord : undefined;
  const delivery = {
    requestId: record.requestId,
    state: record.state,
    attemptCount: record.attemptCount,
    failureCode: record.state === "failed" ? record.failureCode : null,
    retryable: retryable(record),
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
    deliveredAtMs: record.state === "delivered" ? record.deliveredAtMs : null,
    planningRequest: matchedPlanningRecord?.request ?? null,
  };
  if (record.state === "delivered" && matchedPlanningRecord === undefined) {
    throw new Error("delivered Planning request is missing");
  }
  return PlanningRequestDeliverySchema.parse(delivery);
}

function planningFailure(error: unknown): { readonly code: string; readonly retryable: boolean } {
  if (error instanceof PlanningRequestStoreError) {
    if (error.code === "request-conflict") {
      return { code: "request_conflict", retryable: false };
    }
    if (error.code === "invalid-create") {
      return { code: "invalid_request", retryable: false };
    }
  }
  return { code: "planning_unavailable", retryable: true };
}

export function createPlanningRequestDeliveryService(
  input: PlanningRequestDeliveryServiceInput,
  dependencies: PlanningRequestDeliveryServiceDependencies = {},
): PlanningRequestOperations {
  const delivery = async (record: ChatPlanOutboxRecord): Promise<PlanningRequestDelivery> => {
    if (record.state === "delivered" || record.state === "cancelled") {
      return project(input.requests, record);
    }
    if (record.state === "failed" && !record.retryable) {
      return project(input.requests, record);
    }

    const attemptedAt = input.identity.hlcStamp();
    const pending = await input.outbox.beginDelivery({
      requestId: record.requestId,
      attemptedAtMs: attemptedAt.physicalMs,
    });
    if (pending.state !== "pending") throw new Error("Planning delivery did not begin");
    let target: PlanningRequestTarget;
    try {
      target = await input.resolveTarget();
    } catch (error) {
      const failure = planningFailure(error);
      const failed = await input.outbox.markFailed({
        requestId: pending.requestId,
        failureCode: failure.code,
        retryable: failure.retryable,
        failedAtMs: input.identity.hlcStamp().physicalMs,
      });
      return project(input.requests, failed);
    }

    let accepted: PlanningRequestRecord;
    try {
      const stamp = input.identity.hlcStamp();
      accepted = await input.requests.createOrGet({
        payload: pending.payload,
        target,
        createdAtMs: stamp.physicalMs,
        deviceId: await input.identity.deviceId(),
        hlcPhysicalMs: stamp.physicalMs,
        hlcCounter: stamp.counter,
      });
    } catch (error) {
      const failure = planningFailure(error);
      const failed = await input.outbox.markFailed({
        requestId: pending.requestId,
        failureCode: failure.code,
        retryable: failure.retryable,
        failedAtMs: input.identity.hlcStamp().physicalMs,
      });
      return project(input.requests, failed);
    }

    try {
      await dependencies.afterPlanningAccepted?.(accepted);
    } catch (error) {
      const failure = planningFailure(error);
      const failed = await input.outbox.markFailed({
        requestId: pending.requestId,
        failureCode: failure.code,
        retryable: failure.retryable,
        failedAtMs: input.identity.hlcStamp().physicalMs,
      });
      return project(input.requests, failed);
    }
    const delivered = await input.outbox.markDelivered({
      requestId: pending.requestId,
      deliveredAtMs: input.identity.hlcStamp().physicalMs,
    });
    return project(input.requests, delivered);
  };

  return {
    async createPlanningRequest(request) {
      const parsed = CreatePlanningRequestRpcParamsSchema.parse(request);
      let record: ChatPlanOutboxRecord;
      try {
        record = await input.outbox.createOrGet({
          payload: parsed.payload,
          createdAtMs: input.identity.hlcStamp().physicalMs,
        });
      } catch (error) {
        if (error instanceof ChatPlanOutboxStoreError) {
          if (error.code === "request-conflict") {
            return CreatePlanningRequestRpcResultSchema.parse({
              status: "rejected",
              reason: "request_conflict",
            });
          }
          if (error.code === "invalid-create") {
            return CreatePlanningRequestRpcResultSchema.parse({
              status: "rejected",
              reason: "invalid_request",
            });
          }
        }
        throw error;
      }
      return CreatePlanningRequestRpcResultSchema.parse({
        status: "accepted",
        delivery: await delivery(record),
      });
    },

    async getPlanningRequest(request) {
      const parsed = GetPlanningRequestRpcParamsSchema.parse(request);
      const record = await input.outbox.read(parsed.requestId);
      return GetPlanningRequestRpcResultSchema.parse(
        record === undefined
          ? { status: "missing" }
          : { status: "found", delivery: await project(input.requests, record) },
      );
    },

    async retryPlanningRequest(request) {
      const parsed = RetryPlanningRequestRpcParamsSchema.parse(request);
      const record = await input.outbox.read(parsed.requestId);
      return RetryPlanningRequestRpcResultSchema.parse(
        record === undefined
          ? { status: "missing" }
          : { status: "found", delivery: await delivery(record) },
      );
    },

    async resumePlanningRequests(request) {
      ResumePlanningRequestsRpcParamsSchema.parse(request);
      const records = await input.outbox.readRecoverable();
      const deliveries: PlanningRequestDelivery[] = [];
      for (const record of records) deliveries.push(await delivery(record));
      return ResumePlanningRequestsRpcResultSchema.parse({ deliveries });
    },
  };
}
