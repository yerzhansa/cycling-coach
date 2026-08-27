import type { AuthoredIdentity } from "@enduragent/kernel-node/home";
import type {
  CreatePlanningRequestPayload,
  PlanningRequestProvenanceSnapshot,
  PlanningRequestRecord,
  PlanningRequestRepository,
} from "@enduragent/kernel/planning";
import type { ChatPlanOutboxRepository } from "@enduragent/kernel/store";

export interface PlanningRequestSourceCleanupInput {
  readonly outbox: ChatPlanOutboxRepository;
  readonly requests: PlanningRequestRepository;
  readonly identity: AuthoredIdentity;
}

function intentSummary(intent: string): string {
  const normalized = intent.trim().replace(/\s+/gu, " ");
  return (normalized.length === 0 ? "Plan request" : normalized).slice(0, 2_000);
}

function workoutSummary(
  payload: CreatePlanningRequestPayload,
): PlanningRequestProvenanceSnapshot["workout"] {
  const selected = payload.sourceSnapshot.selectedWorkout;
  if (selected === null) return null;
  const title = selected.workout.title;
  const sport = selected.workout.sport;
  const durationSeconds = selected.workout.durationSeconds;
  if (
    typeof title !== "string" ||
    title.length === 0 ||
    typeof sport !== "string" ||
    sport.length === 0 ||
    !Number.isSafeInteger(durationSeconds) ||
    (durationSeconds as number) <= 0
  ) {
    throw new TypeError("Planning request Workout provenance is unavailable.");
  }
  return {
    setId: selected.setId,
    workoutId: selected.workoutId,
    name: title,
    sport,
    durationSeconds: durationSeconds as number,
  };
}

function provenance(record: PlanningRequestRecord): PlanningRequestProvenanceSnapshot {
  const payload = record.sourceState.payload;
  if (payload === null) throw new TypeError("Planning request source is unavailable.");
  return {
    requestId: payload.requestId,
    kind: payload.kind,
    intentSummary: intentSummary(payload.intent),
    source: {
      chatId: payload.source.chatId,
      messageId: payload.source.messageId,
      sourceDeleted: true,
    },
    attachment: payload.sourceSnapshot.attachment,
    workout: workoutSummary(payload),
    capturedAt: payload.sourceSnapshot.capturedAt,
  };
}

export function createPlanningRequestSourceCleanup(
  input: PlanningRequestSourceCleanupInput,
): (chatId: string) => Promise<void> {
  return async (chatId) => {
    const deviceId = await input.identity.deviceId();
    const outboxRecords = await input.outbox.readByChatId(chatId);
    for (const outboxRecord of outboxRecords) {
      if (outboxRecord.state === "pending" || outboxRecord.state === "failed") {
        const stamp = input.identity.hlcStamp();
        await input.outbox.cancelUndelivered({
          requestId: outboxRecord.requestId,
          cancelledAtMs: stamp.physicalMs,
        });
        continue;
      }
      if (outboxRecord.state !== "delivered") continue;

      let request = await input.requests.read(outboxRecord.requestId);
      if (request === undefined || request.payloadHash !== outboxRecord.payloadHash) {
        throw new TypeError("Delivered Planning request is unavailable.");
      }
      if (request.sourceState.status === "linked") {
        const stamp = input.identity.hlcStamp();
        request = await input.requests.detachSource({
          requestId: request.request.requestId,
          expectedRevision: request.request.revision,
          provenance: provenance(request),
          updatedAtMs: stamp.physicalMs,
          deviceId,
          hlcPhysicalMs: stamp.physicalMs,
          hlcCounter: stamp.counter,
        });
      }
      if (
        request.request.lifecycle !== "open" &&
        request.sourceState.status === "detached_open"
      ) {
        const stamp = input.identity.hlcStamp();
        request = await input.requests.compactSource({
          requestId: request.request.requestId,
          expectedRevision: request.request.revision,
          updatedAtMs: stamp.physicalMs,
          deviceId,
          hlcPhysicalMs: stamp.physicalMs,
          hlcCounter: stamp.counter,
        });
      }
      const stamp = input.identity.hlcStamp();
      await input.outbox.detachDeliveredSource({
        requestId: outboxRecord.requestId,
        sourceDeletedAtMs: stamp.physicalMs,
      });
    }
  };
}
