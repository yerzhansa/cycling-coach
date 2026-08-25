import { createHash } from "node:crypto";
import type {
  ChatAttachmentActivitySummary,
  ChatAttachmentTurnPort,
  ChatAttachmentTurnPreparation,
} from "@enduragent/engine";
import { readRepairFixerSettings, type ImportReport } from "@enduragent/kernel/ingest";
import type {
  ChatAttachmentObjectRow,
  ChatAttachmentRepository,
  ChatAttachmentRow,
  CanonicalActivityProjection,
  FailedChatAttachmentProjection,
  ParsedActivityProjection,
  SqlStore,
} from "@enduragent/kernel/store";
import {
  MANAGED_ACTIVITY_PARSER_VERSION,
  ManagedActivityReaderError,
  type ManagedActivityExtension,
  type ManagedActivityReader,
  type ManagedActivitySource,
} from "@enduragent/kernel-node/chat-attachments";
import type { NodeImportRuntime } from "@enduragent/kernel-node/ingest";

export class ActivityAttachmentTurnError extends Error {
  constructor(readonly code: string) {
    super("completed activity attachment could not be prepared");
    this.name = "ActivityAttachmentTurnError";
  }
}

export class ActivityAttachmentInterruption extends Error {
  constructor(readonly checkpoint: string) {
    super("simulated activity attachment interruption");
    this.name = "ActivityAttachmentInterruption";
  }
}

export interface ActivityAttachmentHooks {
  readonly beforeMessageLink?: (messageId: string) => Promise<void> | void;
  readonly beforeImport?: (attachmentId: string) => Promise<void> | void;
  readonly afterImport?: (attachmentId: string, report: ImportReport) => Promise<void> | void;
  readonly beforeCoachStart?: (activityIds: readonly string[]) => Promise<void> | void;
}

export interface ActivityAttachmentOperations {
  readonly turnPort: ChatAttachmentTurnPort;
  preprocessAdmitted(input: {
    readonly attachment: ChatAttachmentRow;
    readonly object: ChatAttachmentObjectRow;
  }): Promise<void>;
}

export interface ActivityAttachmentOperationsInput {
  readonly repository: ChatAttachmentRepository;
  readonly reader: ManagedActivityReader;
  readonly importer: NodeImportRuntime;
  readonly store: SqlStore;
  readonly runExclusive: <T>(work: () => Promise<T>) => Promise<T>;
  readonly now?: () => number;
  readonly hooks?: ActivityAttachmentHooks;
}

const ACTIVITY_EXTENSIONS = new Set<ManagedActivityExtension>(["fit", "tcx", "gpx"]);

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parseObject(value: string | null): Record<string, unknown> {
  if (value === null) throw new ActivityAttachmentTurnError("attachment_state_missing");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ActivityAttachmentTurnError("attachment_state_invalid");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ActivityAttachmentTurnError("attachment_state_invalid");
  }
  return parsed as Record<string, unknown>;
}

function parsedProjection(attachment: ChatAttachmentRow): ParsedActivityProjection {
  if (!ACTIVITY_EXTENSIONS.has(attachment.extension as ManagedActivityExtension)) {
    throw new ActivityAttachmentTurnError("activity_extension_invalid");
  }
  const state = attachment.state_json === null ? undefined : parseObject(attachment.state_json);
  if (state?.kind === "parsed-activity") {
    if (
      state.parsedActivityId !== attachment.sha256 ||
      state.sourceFormat !== attachment.extension ||
      typeof state.parserVersion !== "string" ||
      state.parserVersion.length < 1
    ) {
      throw new ActivityAttachmentTurnError("activity_projection_invalid");
    }
    return state as unknown as ParsedActivityProjection;
  }
  return {
    kind: "parsed-activity",
    parsedActivityId: attachment.sha256,
    sourceFormat: attachment.extension as ManagedActivityExtension,
    parserVersion: MANAGED_ACTIVITY_PARSER_VERSION,
  };
}

function canonicalProjection(attachment: ChatAttachmentRow): CanonicalActivityProjection {
  const state = parseObject(attachment.state_json);
  if (
    state.kind !== "canonical-activity" ||
    typeof state.importId !== "string" ||
    state.importId.length < 1 ||
    !Array.isArray(state.activityIds) ||
    state.activityIds.length < 1 ||
    state.activityIds.some((id) => typeof id !== "string" || id.length < 1)
  ) {
    throw new ActivityAttachmentTurnError("canonical_activity_projection_invalid");
  }
  return state as unknown as CanonicalActivityProjection;
}

function source(
  attachment: ChatAttachmentRow,
  object: ChatAttachmentObjectRow,
): ManagedActivitySource {
  if (
    attachment.kind !== "activity" ||
    object.id !== attachment.object_id ||
    object.status !== "durable" ||
    object.sha256 !== attachment.sha256 ||
    object.byte_size !== attachment.byte_size ||
    !ACTIVITY_EXTENSIONS.has(attachment.extension as ManagedActivityExtension)
  ) {
    throw new ActivityAttachmentTurnError("activity_source_invalid");
  }
  return {
    objectId: object.id,
    relativePath: object.relative_path,
    displayName: attachment.display_name,
    byteSize: object.byte_size,
    sha256: object.sha256,
    extension: attachment.extension as ManagedActivityExtension,
  };
}

function importId(attachmentId: string, messageId: string): string {
  return createHash("sha256")
    .update("chat-activity-import\0", "utf8")
    .update(attachmentId, "utf8")
    .update("\0", "utf8")
    .update(messageId, "utf8")
    .digest("hex");
}

function failureCode(error: unknown): string {
  if (error instanceof ManagedActivityReaderError) return error.reason;
  if (error instanceof ActivityAttachmentTurnError) return error.code;
  return "activity_import_failed";
}

export function createActivityAttachmentOperations(
  input: ActivityAttachmentOperationsInput,
): ActivityAttachmentOperations {
  const now = input.now ?? Date.now;

  const preprocess = async (
    attachment: ChatAttachmentRow,
    object: ChatAttachmentObjectRow,
  ): Promise<ChatAttachmentRow> => {
    if (attachment.kind !== "activity") return attachment;
    if (attachment.status !== "preprocessing") return attachment;
    try {
      const result = await input.reader.read(
        source(attachment, object),
        await readRepairFixerSettings(input.store),
      );
      if (result.outcome === "quarantined") {
        return input.repository.transitionAttachment({
          conversationId: attachment.conversation_id,
          attachmentId: attachment.id,
          from: ["preprocessing"],
          to: "failed",
          stateJson: json({
            stage: "parsing",
            failureCode: result.code,
          } satisfies FailedChatAttachmentProjection),
          messageId: null,
          updatedAtMs: now(),
        });
      }
      return input.repository.transitionAttachment({
        conversationId: attachment.conversation_id,
        attachmentId: attachment.id,
        from: ["preprocessing"],
        to: "ready",
        stateJson: json(result.projection),
        messageId: null,
        updatedAtMs: now(),
      });
    } catch (error) {
      return input.repository.transitionAttachment({
        conversationId: attachment.conversation_id,
        attachmentId: attachment.id,
        from: ["preprocessing"],
        to: "failed",
        stateJson: json({
          stage: "parsing",
          failureCode: failureCode(error),
        } satisfies FailedChatAttachmentProjection),
        messageId: null,
        updatedAtMs: now(),
      });
    }
  };

  const activityIdsForReport = async (
    report: ImportReport,
    sha256: string,
  ): Promise<readonly string[]> => {
    const ids: string[] = [];
    for (const cluster of report.clusters) {
      if (!cluster.members.includes(sha256)) continue;
      for (const row of await input.store.all(
        "SELECT session_key FROM session WHERE workout_key=? ORDER BY session_seq,session_key",
        [cluster.workout_key],
      )) {
        const id = String(row.session_key);
        if (!ids.includes(id)) ids.push(id);
      }
    }
    if (ids.length === 0) throw new ActivityAttachmentTurnError("canonical_activity_missing");
    return ids;
  };

  const summarize = async (
    attachment: ChatAttachmentRow,
    projection: CanonicalActivityProjection,
  ): Promise<ChatAttachmentActivitySummary> => {
    const sessions: ChatAttachmentActivitySummary["sessions"][number][] = [];
    for (const activityId of projection.activityIds) {
      const row = await input.store.get(
        `SELECT session_key,sport,start_utc,elapsed_s,distance_m
           FROM session WHERE session_key=?`,
        [activityId],
      );
      if (row === undefined) throw new ActivityAttachmentTurnError("canonical_activity_missing");
      sessions.push({
        activityId: String(row.session_key),
        sport: String(row.sport),
        startUtc: Number(row.start_utc),
        elapsedSeconds: row.elapsed_s === null ? null : Number(row.elapsed_s),
        distanceMeters: row.distance_m === null ? null : Number(row.distance_m),
      });
    }
    if (attachment.message_id === null) {
      throw new ActivityAttachmentTurnError("attachment_message_missing");
    }
    return {
      attachmentId: attachment.id,
      messageId: attachment.message_id,
      activityIds: projection.activityIds,
      sessions,
    };
  };

  const ensureImported = async (
    initial: ChatAttachmentRow,
    messageId: string,
  ): Promise<ChatAttachmentActivitySummary> => {
    let attachment = initial;
    if (attachment.kind !== "activity") {
      throw new ActivityAttachmentTurnError("attachment_kind_invalid");
    }
    if (attachment.status === "preprocessing") {
      const object = await input.repository.readObject(attachment.object_id);
      if (object === undefined) throw new ActivityAttachmentTurnError("activity_source_missing");
      attachment = await preprocess(attachment, object);
    }
    if (attachment.status === "failed") {
      const state = parseObject(attachment.state_json);
      if (state.stage !== "import") {
        throw new ActivityAttachmentTurnError(String(state.failureCode ?? "activity_parse_failed"));
      }
    }
    if (attachment.status === "ready" || attachment.status === "failed") {
      const projection = parsedProjection(attachment);
      attachment = await input.repository.transitionAttachment({
        conversationId: attachment.conversation_id,
        attachmentId: attachment.id,
        from: ["ready", "failed"],
        to: "importing",
        stateJson: json(projection),
        messageId,
        updatedAtMs: now(),
      });
    }
    if (attachment.message_id !== messageId) {
      throw new ActivityAttachmentTurnError("attachment_message_conflict");
    }
    if (attachment.status === "importing") {
      const object = await input.repository.readObject(attachment.object_id);
      if (object === undefined) throw new ActivityAttachmentTurnError("activity_source_missing");
      try {
        await input.hooks?.beforeImport?.(attachment.id);
        const prepared = await input.reader.read(
          source(attachment, object),
          await readRepairFixerSettings(input.store),
        );
        if (prepared.outcome === "quarantined") {
          throw new ActivityAttachmentTurnError(prepared.code);
        }
        const report = await input.importer.importBatchWithPreparation(
          { files: [prepared.artifact], platform_records: [] },
          async () => prepared.prepared,
        );
        await input.hooks?.afterImport?.(attachment.id, report);
        const projection: CanonicalActivityProjection = {
          kind: "canonical-activity",
          importId: importId(attachment.id, messageId),
          activityIds: await activityIdsForReport(report, attachment.sha256),
        };
        attachment = await input.repository.transitionAttachment({
          conversationId: attachment.conversation_id,
          attachmentId: attachment.id,
          from: ["importing"],
          to: "imported",
          stateJson: json(projection),
          messageId,
          updatedAtMs: now(),
        });
      } catch (error) {
        if (error instanceof ActivityAttachmentInterruption) throw error;
        await input.repository.transitionAttachment({
          conversationId: attachment.conversation_id,
          attachmentId: attachment.id,
          from: ["importing"],
          to: "failed",
          stateJson: json({
            stage: "import",
            failureCode: failureCode(error),
          } satisfies FailedChatAttachmentProjection),
          messageId,
          updatedAtMs: now(),
        });
        throw error;
      }
    }
    if (attachment.status !== "imported" && attachment.status !== "sent") {
      throw new ActivityAttachmentTurnError("activity_import_incomplete");
    }
    return summarize(attachment, canonicalProjection(attachment));
  };

  const turnPort: ChatAttachmentTurnPort = {
    prepareQueuedTurn: (request): Promise<ChatAttachmentTurnPreparation> =>
      input.runExclusive(async () => {
        const activities: ChatAttachmentActivitySummary[] = [];
        for (const message of request.messages) {
          await input.hooks?.beforeMessageLink?.(message.messageId);
          await input.repository.linkMessage({
            conversationId: request.chatId,
            messageId: message.messageId,
            attachmentIds: message.attachmentIds,
            createdAtMs: now(),
          });
          for (const attachment of await input.repository.listMessageAttachments(
            message.messageId,
          )) {
            if (attachment.kind === "activity") {
              activities.push(await ensureImported(attachment, message.messageId));
            }
          }
        }
        await input.hooks?.beforeCoachStart?.(
          activities.flatMap((activity) => activity.activityIds),
        );
        return { activities };
      }),
    completeQueuedTurn: (request) =>
      input.runExclusive(async () => {
        for (const messageId of request.messageIds) {
          for (const attachment of await input.repository.listMessageAttachments(messageId)) {
            if (attachment.kind !== "activity" || attachment.status === "sent") continue;
            if (attachment.status !== "imported") {
              throw new ActivityAttachmentTurnError("activity_import_incomplete");
            }
            await input.repository.transitionAttachment({
              conversationId: request.chatId,
              attachmentId: attachment.id,
              from: ["imported"],
              to: "sent",
              stateJson: attachment.state_json,
              messageId,
              updatedAtMs: now(),
            });
          }
        }
      }),
  };

  return {
    turnPort,
    preprocessAdmitted: ({ attachment, object }) => preprocess(attachment, object).then(() => {}),
  };
}
