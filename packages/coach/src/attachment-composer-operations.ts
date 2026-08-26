import {
  ChatAttachmentComposerReadModelSchema,
  type AttachmentCapabilitiesReadModel,
  type ChatAttachmentComposerItem,
  type ChatAttachmentComposerReadModel,
} from "@enduragent/coach-contract";
import type {
  ChatAttachmentDraft,
  ChatAttachmentRepository,
  ChatAttachmentRow,
} from "@enduragent/kernel/store";
import type {
  NormalizedWorkout,
  NormalizedWorkoutSet,
  WorkoutPowerTarget,
} from "@enduragent/sport-cycling/workout-import";
import type { ActivityAttachmentOperations } from "./activity-attachment-operations.js";
import type { ManagedChatAttachmentOperations } from "./attachment-operations.js";
import type { WorkoutAttachmentOperations } from "./workout-attachment-operations.js";

export interface AttachmentComposerOperations {
  read(chatId: string): Promise<ChatAttachmentComposerReadModel>;
  saveText(chatId: string, text: string): Promise<ChatAttachmentComposerReadModel>;
  remove(chatId: string, attachmentId: string): Promise<ChatAttachmentComposerReadModel>;
  retry(chatId: string, attachmentId: string): Promise<ChatAttachmentComposerReadModel>;
  selectWorkout(
    chatId: string,
    attachmentId: string,
    workoutId: string,
  ): Promise<ChatAttachmentComposerReadModel>;
  clear(chatId: string): Promise<ChatAttachmentComposerReadModel>;
}

export interface AttachmentComposerOperationsInput {
  readonly repository: ChatAttachmentRepository;
  readonly attachments: ManagedChatAttachmentOperations;
  readonly activities: Pick<ActivityAttachmentOperations, "readPreview">;
  readonly workouts: Pick<WorkoutAttachmentOperations, "readWorkoutSet" | "selectWorkout">;
  readonly capabilities: () => Promise<AttachmentCapabilitiesReadModel>;
}

function parseState(value: ChatAttachmentRow): Record<string, unknown> {
  if (value.state_json === null) return {};
  try {
    const parsed: unknown = JSON.parse(value.state_json);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function roundTarget(value: number): number {
  return Math.round(value * 10) / 10;
}

function powerBounds(target: WorkoutPowerTarget): {
  readonly unit: "% FTP" | "W";
  readonly low: number;
  readonly high: number;
} {
  if (target.kind === "watts_range") {
    return { unit: "W", low: target.low, high: target.high };
  }
  if (target.kind === "ftp_fraction_range") {
    return { unit: "% FTP", low: target.low * 100, high: target.high * 100 };
  }
  return { unit: "% FTP", low: target.low, high: target.high };
}

function workoutTarget(workout: NormalizedWorkout): string {
  const bounds = workout.segments.flatMap((segment) =>
    segment.power === undefined ? [] : [powerBounds(segment.power)],
  );
  if (bounds.length === 0) return "Free ride";
  const unit = bounds[0]!.unit;
  if (bounds.some((bound) => bound.unit !== unit)) return "Mixed targets";
  const low = roundTarget(Math.min(...bounds.map((bound) => bound.low)));
  const high = roundTarget(Math.max(...bounds.map((bound) => bound.high)));
  return low === high ? `${low}${unit}` : `${low}–${high}${unit}`;
}

function workoutPreview(set: NormalizedWorkoutSet) {
  return {
    kind: "workout" as const,
    sourceFormat: set.sourceFormat,
    selectedWorkoutId: set.selectedWorkoutId,
    workouts: set.workouts.map((workout) => ({
      workoutId: workout.workoutId,
      title: workout.title,
      durationSeconds: workout.durationSeconds,
      target: workoutTarget(workout),
      purpose: workout.purpose,
    })),
  };
}

function base(attachment: ChatAttachmentRow) {
  return {
    schemaVersion: 1 as const,
    attachmentId: attachment.id,
    displayName: attachment.display_name,
    kind: attachment.kind,
    extension: attachment.extension as ChatAttachmentComposerItem["extension"],
    byteSize: attachment.byte_size,
  };
}

function blockedReason(
  state: Record<string, unknown>,
): Extract<ChatAttachmentComposerItem, { status: "blocked" }>["reason"] {
  const reason = state.reason;
  return reason === "encrypted_pdf" ||
    reason === "metadata_stale" ||
    reason === "model_incompatible" ||
    reason === "validation_failed" ||
    reason === "visual_pdf_unsupported"
    ? reason
    : "validation_failed";
}

function failedStage(
  state: Record<string, unknown>,
): Extract<ChatAttachmentComposerItem, { status: "failed" }>["stage"] {
  return state.stage === "storage" || state.stage === "import" ? state.stage : "parsing";
}

async function readyItem(
  input: AttachmentComposerOperationsInput,
  attachment: ChatAttachmentRow,
  capabilities: AttachmentCapabilitiesReadModel,
): Promise<ChatAttachmentComposerItem> {
  const item = base(attachment);
  const state = parseState(attachment);
  if (attachment.kind === "document") {
    const visualPageNumbers = Array.isArray(state.visualPageNumbers)
      ? state.visualPageNumbers.filter(Number.isSafeInteger)
      : [];
    if (visualPageNumbers.length > 0 && !capabilities.images.enabled) {
      return { ...item, status: "blocked", reason: "visual_pdf_unsupported" };
    }
    return {
      ...item,
      status: "ready",
      preview: {
        kind: "document",
        extractedTextChars: Number.isSafeInteger(state.extractedTextChars)
          ? Number(state.extractedTextChars)
          : 0,
        visualPageCount: visualPageNumbers.length,
      },
    };
  }
  if (attachment.kind === "activity") {
    const preview = await input.activities.readPreview(attachment.id);
    return {
      ...item,
      status: "ready",
      preview: {
        kind: "activity",
        sourceFormat: preview.sourceFormat,
        sessions: preview.sessions.map((session) => ({ ...session })),
      },
    };
  }
  if (attachment.kind === "workout") {
    return {
      ...item,
      status: "ready",
      preview: workoutPreview(await input.workouts.readWorkoutSet(attachment.id)),
    };
  }
  if (!capabilities.images.enabled) {
    return {
      ...item,
      status: "blocked",
      reason:
        capabilities.images.reason === "metadata_stale" ? "metadata_stale" : "model_incompatible",
    };
  }
  return {
    ...item,
    status: "ready",
    preview: {
      kind: "image",
      mediaType:
        state.mediaType === "image/png" ||
        state.mediaType === "image/jpeg" ||
        state.mediaType === "image/webp"
          ? state.mediaType
          : "image/png",
      width: Number.isSafeInteger(state.width) ? Number(state.width) : 1,
      height: Number.isSafeInteger(state.height) ? Number(state.height) : 1,
    },
  };
}

async function composerItem(
  input: AttachmentComposerOperationsInput,
  attachment: ChatAttachmentRow,
  capabilities: AttachmentCapabilitiesReadModel,
): Promise<ChatAttachmentComposerItem> {
  const item = base(attachment);
  const state = parseState(attachment);
  if (attachment.status === "preprocessing") return { ...item, status: "preprocessing" };
  if (attachment.status === "blocked") {
    return { ...item, status: "blocked", reason: blockedReason(state) };
  }
  if (attachment.status === "failed") {
    return {
      ...item,
      status: "failed",
      stage: failedStage(state),
      failureCode:
        typeof state.failureCode === "string" && state.failureCode.length > 0
          ? state.failureCode.slice(0, 128)
          : "attachment_failed",
      retryable: true,
    };
  }
  if (attachment.status === "ready") return readyItem(input, attachment, capabilities);
  return {
    ...item,
    status: "failed",
    stage: "import",
    failureCode: "attachment_already_submitted",
    retryable: false,
  };
}

async function readDraft(
  input: AttachmentComposerOperationsInput,
  chatId: string,
  capabilities: AttachmentCapabilitiesReadModel,
): Promise<ChatAttachmentComposerReadModel["draft"]> {
  const draft: ChatAttachmentDraft | undefined = await input.repository.readDraft(chatId);
  if (draft === undefined) return null;
  const attachments: ChatAttachmentComposerItem[] = [];
  for (const attachmentId of draft.attachmentIds) {
    const attachment = await input.repository.readAttachment(attachmentId);
    if (attachment === undefined || attachment.conversation_id !== chatId) continue;
    attachments.push(await composerItem(input, attachment, capabilities));
  }
  if (draft.text.length === 0 && attachments.length === 0) return null;
  return {
    schemaVersion: 1,
    chatId,
    text: draft.text,
    state: draft.state,
    updatedAt: new Date(draft.updatedAtMs).toISOString(),
    attachments,
  };
}

export function createAttachmentComposerOperations(
  input: AttachmentComposerOperationsInput,
): AttachmentComposerOperations {
  const read = async (chatId: string): Promise<ChatAttachmentComposerReadModel> => {
    const capabilities = await input.capabilities();
    return ChatAttachmentComposerReadModelSchema.parse({
      schemaVersion: 1,
      capabilities,
      draft: await readDraft(input, chatId, capabilities),
    });
  };
  return {
    read,
    async saveText(chatId, text) {
      await input.attachments.saveDraftText(chatId, text);
      return read(chatId);
    },
    async remove(chatId, attachmentId) {
      await input.attachments.removeDraftAttachment(chatId, attachmentId);
      return read(chatId);
    },
    async retry(chatId, attachmentId) {
      await input.attachments.retryDraftAttachment(chatId, attachmentId);
      return read(chatId);
    },
    async selectWorkout(chatId, attachmentId, workoutId) {
      await input.workouts.selectWorkout({ conversationId: chatId, attachmentId, workoutId });
      return read(chatId);
    },
    async clear(chatId) {
      await input.attachments.clearDraft(chatId);
      return read(chatId);
    },
  };
}
