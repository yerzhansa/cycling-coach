import type { MigratorStore } from "../store/migrator.js";
import type { Row, SqlStore } from "../store/ports.js";
import {
  ChatAttachmentInvariantError,
  type ChatAttachmentCapacityLimits,
  type ChatAttachmentDraft,
  type ChatAttachmentDraftState,
  type ChatAttachmentKind,
  type ChatAttachmentObjectReservation,
  type ChatAttachmentObjectRow,
  type ChatAttachmentRepository,
  type ChatAttachmentRow,
  type ChatAttachmentStatus,
} from "./types.js";

type TransactionalStore = SqlStore & Pick<MigratorStore, "transaction">;

const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const EXTENSIONS = new Set([
  "pdf",
  "txt",
  "csv",
  "docx",
  "fit",
  "tcx",
  "gpx",
  "zwo",
  "mrc",
  "erg",
  "png",
  "jpg",
  "jpeg",
  "webp",
]);
const KIND_EXTENSIONS: Readonly<Record<ChatAttachmentKind, ReadonlySet<string>>> = {
  document: new Set(["pdf", "txt", "csv", "docx"]),
  activity: new Set(["fit", "tcx", "gpx"]),
  workout: new Set(["zwo", "mrc", "erg"]),
  image: new Set(["png", "jpg", "jpeg", "webp"]),
};
const STATUSES = new Set<ChatAttachmentStatus>([
  "preprocessing",
  "blocked",
  "failed",
  "ready",
  "importing",
  "imported",
  "sent",
]);
const DRAFT_STATES = new Set<ChatAttachmentDraftState>([
  "active",
  "restored",
  "submitting",
  "clearing",
]);
const STATUS_TRANSITIONS: Readonly<
  Record<ChatAttachmentStatus, ReadonlySet<ChatAttachmentStatus>>
> = {
  preprocessing: new Set(["ready", "blocked", "failed"]),
  blocked: new Set(["preprocessing"]),
  failed: new Set(["preprocessing", "importing"]),
  ready: new Set(["blocked", "importing", "sent"]),
  importing: new Set(["imported", "failed"]),
  imported: new Set(["sent"]),
  sent: new Set(),
};

function integer(value: number, name: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new ChatAttachmentInvariantError(`invalid_${name}`, `${name} is invalid`);
  }
}

function validateLimits(limits: ChatAttachmentCapacityLimits): void {
  integer(limits.attachmentsPerMessage, "attachments_per_message", 1);
  integer(limits.messageBytes, "message_bytes", 1);
  integer(limits.conversationBytes, "conversation_bytes", 1);
  integer(limits.athleteBytes, "athlete_bytes", 1);
  if (
    limits.messageBytes > limits.conversationBytes ||
    limits.conversationBytes > limits.athleteBytes
  ) {
    throw new ChatAttachmentInvariantError(
      "invalid_capacity_limits",
      "attachment capacity limits are inconsistent",
    );
  }
}

function validateObject(row: ChatAttachmentObjectRow): void {
  if (!SAFE_ID.test(row.id))
    throw new ChatAttachmentInvariantError("invalid_object_id", "attachment object id is invalid");
  if (row.conversation_id.length < 1 || row.conversation_id.length > 512) {
    throw new ChatAttachmentInvariantError("invalid_conversation_id", "conversation id is invalid");
  }
  if (!SHA256.test(row.conversation_key) || !SHA256.test(row.sha256)) {
    throw new ChatAttachmentInvariantError("invalid_digest", "attachment digest is invalid");
  }
  integer(row.byte_size, "byte_size", 1);
  if (
    !row.relative_path.startsWith(`chat-attachments/${row.conversation_key}/`) ||
    row.relative_path.includes("\\") ||
    row.relative_path.includes("..")
  ) {
    throw new ChatAttachmentInvariantError("invalid_relative_path", "attachment path is invalid");
  }
  if (row.status !== "reserved" && row.status !== "durable" && row.status !== "failed") {
    throw new ChatAttachmentInvariantError(
      "invalid_object_status",
      "attachment object status is invalid",
    );
  }
  if ((row.status === "failed") !== (row.failure_code !== null)) {
    throw new ChatAttachmentInvariantError(
      "invalid_failure",
      "attachment object failure state is invalid",
    );
  }
  integer(row.created_at_ms, "created_at_ms");
  integer(row.updated_at_ms, "updated_at_ms");
  if (row.updated_at_ms < row.created_at_ms) {
    throw new ChatAttachmentInvariantError(
      "invalid_timestamp",
      "attachment object timestamps are invalid",
    );
  }
}

function validateAttachment(row: ChatAttachmentRow): void {
  if (!SAFE_ID.test(row.id) || !SAFE_ID.test(row.object_id)) {
    throw new ChatAttachmentInvariantError("invalid_attachment_id", "attachment id is invalid");
  }
  if (row.schema_version !== 1)
    throw new ChatAttachmentInvariantError(
      "invalid_schema_version",
      "attachment schema version is invalid",
    );
  if (row.conversation_id.length < 1 || row.conversation_id.length > 512) {
    throw new ChatAttachmentInvariantError("invalid_conversation_id", "conversation id is invalid");
  }
  if (!KIND_EXTENSIONS[row.kind]?.has(row.extension) || !EXTENSIONS.has(row.extension)) {
    throw new ChatAttachmentInvariantError(
      "invalid_extension",
      "attachment extension does not match its kind",
    );
  }
  if (
    row.display_name.length < 1 ||
    row.display_name.length > 512 ||
    row.media_type.length < 1 ||
    row.media_type.length > 256
  ) {
    throw new ChatAttachmentInvariantError("invalid_metadata", "attachment metadata is invalid");
  }
  integer(row.byte_size, "byte_size", 1);
  if (!SHA256.test(row.sha256) || !STATUSES.has(row.status)) {
    throw new ChatAttachmentInvariantError("invalid_attachment", "attachment row is invalid");
  }
  if (row.state_json !== null) {
    try {
      JSON.parse(row.state_json);
    } catch {
      throw new ChatAttachmentInvariantError(
        "invalid_state_json",
        "attachment state is invalid JSON",
      );
    }
  }
  integer(row.created_at_ms, "created_at_ms");
  integer(row.updated_at_ms, "updated_at_ms");
  if (row.updated_at_ms < row.created_at_ms) {
    throw new ChatAttachmentInvariantError(
      "invalid_timestamp",
      "attachment timestamps are invalid",
    );
  }
}

function mapObject(row: Row): ChatAttachmentObjectRow {
  const value: ChatAttachmentObjectRow = {
    id: String(row.id),
    conversation_id: String(row.conversation_id),
    conversation_key: String(row.conversation_key),
    sha256: String(row.sha256),
    byte_size: Number(row.byte_size),
    relative_path: String(row.relative_path),
    status: String(row.status) as ChatAttachmentObjectRow["status"],
    failure_code: row.failure_code === null ? null : String(row.failure_code),
    created_at_ms: Number(row.created_at_ms),
    updated_at_ms: Number(row.updated_at_ms),
  };
  validateObject(value);
  return value;
}

function mapAttachment(row: Row): ChatAttachmentRow {
  const value: ChatAttachmentRow = {
    id: String(row.id),
    schema_version: Number(row.schema_version) as 1,
    conversation_id: String(row.conversation_id),
    object_id: String(row.object_id),
    kind: String(row.kind) as ChatAttachmentKind,
    display_name: String(row.display_name),
    media_type: String(row.media_type),
    extension: String(row.extension),
    byte_size: Number(row.byte_size),
    sha256: String(row.sha256),
    status: String(row.status) as ChatAttachmentStatus,
    state_json: row.state_json === null ? null : String(row.state_json),
    message_id: row.message_id === null ? null : String(row.message_id),
    created_at_ms: Number(row.created_at_ms),
    updated_at_ms: Number(row.updated_at_ms),
  };
  validateAttachment(value);
  return value;
}

const OBJECT_COLUMNS =
  "id,conversation_id,conversation_key,sha256,byte_size,relative_path,status,failure_code,created_at_ms,updated_at_ms";
const ATTACHMENT_COLUMNS =
  "id,schema_version,conversation_id,object_id,kind,display_name,media_type,extension,byte_size,sha256,status,state_json,message_id,created_at_ms,updated_at_ms";

async function readDraft(
  store: SqlStore,
  conversationId: string,
): Promise<ChatAttachmentDraft | undefined> {
  const row = await store.get(
    "SELECT conversation_id,schema_version,text,state,updated_at_ms FROM chat_attachment_draft WHERE conversation_id=?",
    [conversationId],
  );
  if (row === undefined) return undefined;
  const refs = await store.all(
    "SELECT attachment_id FROM chat_attachment_draft_ref WHERE conversation_id=? ORDER BY ordinal ASC",
    [conversationId],
  );
  const state = String(row.state) as ChatAttachmentDraftState;
  if (!DRAFT_STATES.has(state) || Number(row.schema_version) !== 1) {
    throw new ChatAttachmentInvariantError("invalid_draft", "attachment draft is invalid");
  }
  return {
    schemaVersion: 1,
    conversationId: String(row.conversation_id),
    text: String(row.text),
    attachmentIds: refs.map((value) => String(value.attachment_id)),
    state,
    updatedAtMs: Number(row.updated_at_ms),
  };
}

async function draftCapacity(
  store: SqlStore,
  conversationId: string,
): Promise<{ readonly count: number; readonly bytes: number }> {
  const row = await store.get(
    `SELECT COUNT(*) AS attachment_count, COALESCE(SUM(a.byte_size),0) AS total_bytes
       FROM chat_attachment_draft_ref r
       JOIN chat_attachment a ON a.id=r.attachment_id
      WHERE r.conversation_id=?`,
    [conversationId],
  );
  return { count: Number(row?.attachment_count ?? 0), bytes: Number(row?.total_bytes ?? 0) };
}

export function createChatAttachmentRepository(
  store: TransactionalStore,
): ChatAttachmentRepository {
  let reservationTail: Promise<void> = Promise.resolve();
  const serializeReservation = <T>(work: () => Promise<T>): Promise<T> => {
    const result = reservationTail.then(work, work);
    reservationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  return {
    async reserveObject({ object, limits }): Promise<ChatAttachmentObjectReservation> {
      validateObject(object);
      if (object.status !== "reserved") {
        throw new ChatAttachmentInvariantError(
          "invalid_object_status",
          "new attachment object must be reserved",
        );
      }
      validateLimits(limits);
      return serializeReservation(() =>
        store.transaction(async () => {
          const draft = await draftCapacity(store, object.conversation_id);
          if (
            draft.count >= limits.attachmentsPerMessage ||
            draft.bytes + object.byte_size > limits.messageBytes
          )
            return { kind: "message_limit" };

          const duplicate = await store.get(
            `SELECT ${OBJECT_COLUMNS} FROM chat_attachment_object
            WHERE conversation_id=? AND sha256=? AND status='durable' LIMIT 1`,
            [object.conversation_id, object.sha256],
          );
          if (duplicate !== undefined) return { kind: "reused", object: mapObject(duplicate) };

          const conversationUsage = await store.get(
            "SELECT COALESCE(SUM(byte_size),0) AS total FROM chat_attachment_object WHERE conversation_id=? AND status IN ('reserved','durable')",
            [object.conversation_id],
          );
          if (Number(conversationUsage?.total ?? 0) + object.byte_size > limits.conversationBytes) {
            return { kind: "storage_full", scope: "conversation" };
          }
          const athleteUsage = await store.get(
            "SELECT COALESCE(SUM(byte_size),0) AS total FROM chat_attachment_object WHERE status IN ('reserved','durable')",
          );
          if (Number(athleteUsage?.total ?? 0) + object.byte_size > limits.athleteBytes) {
            return { kind: "storage_full", scope: "athlete" };
          }
          await store.run(
            `INSERT INTO chat_attachment_object (${OBJECT_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [
              object.id,
              object.conversation_id,
              object.conversation_key,
              object.sha256,
              object.byte_size,
              object.relative_path,
              object.status,
              object.failure_code,
              object.created_at_ms,
              object.updated_at_ms,
            ],
          );
          return { kind: "reserved", object };
        }),
      );
    },

    async commitAdmission({ objectId, attachment, draftUpdatedAtMs }) {
      validateAttachment(attachment);
      integer(draftUpdatedAtMs, "draft_updated_at_ms");
      return store.transaction(async () => {
        const object = await store.get(
          `SELECT ${OBJECT_COLUMNS} FROM chat_attachment_object WHERE id=?`,
          [objectId],
        );
        if (object === undefined)
          throw new ChatAttachmentInvariantError("object_missing", "attachment object is missing");
        const mapped = mapObject(object);
        if (
          mapped.conversation_id !== attachment.conversation_id ||
          mapped.sha256 !== attachment.sha256 ||
          mapped.byte_size !== attachment.byte_size
        ) {
          throw new ChatAttachmentInvariantError(
            "object_mismatch",
            "attachment metadata does not match its object",
          );
        }
        if (mapped.status === "failed")
          throw new ChatAttachmentInvariantError(
            "object_failed",
            "attachment object is unavailable",
          );
        if (mapped.status === "reserved") {
          await store.run(
            "UPDATE chat_attachment_object SET status='durable',updated_at_ms=? WHERE id=? AND status='reserved'",
            [attachment.updated_at_ms, objectId],
          );
        }
        await store.run(
          `INSERT INTO chat_attachment (${ATTACHMENT_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            attachment.id,
            attachment.schema_version,
            attachment.conversation_id,
            attachment.object_id,
            attachment.kind,
            attachment.display_name,
            attachment.media_type,
            attachment.extension,
            attachment.byte_size,
            attachment.sha256,
            attachment.status,
            attachment.state_json,
            attachment.message_id,
            attachment.created_at_ms,
            attachment.updated_at_ms,
          ],
        );
        await store.run(
          `INSERT INTO chat_attachment_draft (conversation_id,schema_version,text,state,updated_at_ms)
           VALUES (?,1,'','active',?)
           ON CONFLICT(conversation_id) DO UPDATE SET state='active',updated_at_ms=excluded.updated_at_ms`,
          [attachment.conversation_id, draftUpdatedAtMs],
        );
        const occupied = new Set(
          (
            await store.all(
              "SELECT ordinal FROM chat_attachment_draft_ref WHERE conversation_id=?",
              [attachment.conversation_id],
            )
          ).map((row) => Number(row.ordinal)),
        );
        let ordinal = 0;
        while (occupied.has(ordinal)) ordinal += 1;
        await store.run(
          "INSERT INTO chat_attachment_draft_ref(conversation_id,attachment_id,ordinal) VALUES (?,?,?)",
          [attachment.conversation_id, attachment.id, ordinal],
        );
        return (await readDraft(store, attachment.conversation_id))!;
      });
    },

    async failObject(objectId, failureCode, updatedAtMs) {
      if (!SAFE_ID.test(objectId) || failureCode.length < 1 || failureCode.length > 128) {
        throw new ChatAttachmentInvariantError(
          "invalid_failure",
          "attachment object failure is invalid",
        );
      }
      integer(updatedAtMs, "updated_at_ms");
      await store.transaction(async () => {
        await store.run(
          "UPDATE chat_attachment_object SET status='failed',failure_code=?,updated_at_ms=? WHERE id=?",
          [failureCode, updatedAtMs, objectId],
        );
        await store.run(
          `UPDATE chat_attachment SET status='failed',state_json=?,updated_at_ms=? WHERE object_id=?`,
          [JSON.stringify({ stage: "storage", failureCode }), updatedAtMs, objectId],
        );
      });
    },

    async readObject(objectId) {
      const row = await store.get(
        `SELECT ${OBJECT_COLUMNS} FROM chat_attachment_object WHERE id=?`,
        [objectId],
      );
      return row === undefined ? undefined : mapObject(row);
    },

    async readAttachment(attachmentId) {
      const row = await store.get(`SELECT ${ATTACHMENT_COLUMNS} FROM chat_attachment WHERE id=?`, [
        attachmentId,
      ]);
      return row === undefined ? undefined : mapAttachment(row);
    },

    readDraft: (conversationId) => readDraft(store, conversationId),

    async saveDraftText({ conversationId, text, state, updatedAtMs }) {
      if (conversationId.length < 1 || !DRAFT_STATES.has(state)) {
        throw new ChatAttachmentInvariantError("invalid_draft", "attachment draft is invalid");
      }
      integer(updatedAtMs, "updated_at_ms");
      return store.transaction(async () => {
        const existing = await readDraft(store, conversationId);
        if (text.length === 0 && (existing?.attachmentIds.length ?? 0) === 0) {
          await store.run("DELETE FROM chat_attachment_draft WHERE conversation_id=?", [
            conversationId,
          ]);
          return undefined;
        }
        await store.run(
          `INSERT INTO chat_attachment_draft(conversation_id,schema_version,text,state,updated_at_ms)
           VALUES (?,1,?,?,?)
           ON CONFLICT(conversation_id) DO UPDATE SET text=excluded.text,state=excluded.state,updated_at_ms=excluded.updated_at_ms`,
          [conversationId, text, state, updatedAtMs],
        );
        return readDraft(store, conversationId);
      });
    },

    async removeDraftAttachment({ conversationId, attachmentId }) {
      return store.transaction(async () => {
        const attachment = await store.get(
          `SELECT ${ATTACHMENT_COLUMNS} FROM chat_attachment WHERE id=? AND conversation_id=?`,
          [attachmentId, conversationId],
        );
        if (attachment === undefined) return { draft: await readDraft(store, conversationId) };
        const mapped = mapAttachment(attachment);
        await store.run(
          "DELETE FROM chat_attachment_draft_ref WHERE conversation_id=? AND attachment_id=?",
          [conversationId, attachmentId],
        );
        const messageRef = await store.get(
          "SELECT 1 AS present FROM chat_message_attachment WHERE attachment_id=? LIMIT 1",
          [attachmentId],
        );
        let unreferencedObject: ChatAttachmentObjectRow | undefined;
        if (messageRef === undefined) {
          await store.run("DELETE FROM chat_attachment WHERE id=?", [attachmentId]);
          const remaining = await store.get(
            "SELECT 1 AS present FROM chat_attachment WHERE object_id=? LIMIT 1",
            [mapped.object_id],
          );
          if (remaining === undefined) {
            const object = await store.get(
              `SELECT ${OBJECT_COLUMNS} FROM chat_attachment_object WHERE id=?`,
              [mapped.object_id],
            );
            if (object !== undefined) {
              unreferencedObject = mapObject(object);
              await store.run("DELETE FROM chat_attachment_object WHERE id=?", [mapped.object_id]);
            }
          }
        }
        const draft = await readDraft(store, conversationId);
        if (draft !== undefined && draft.text.length === 0 && draft.attachmentIds.length === 0) {
          await store.run("DELETE FROM chat_attachment_draft WHERE conversation_id=?", [
            conversationId,
          ]);
          return unreferencedObject === undefined ? {} : { unreferencedObject };
        }
        return {
          ...(draft === undefined ? {} : { draft }),
          ...(unreferencedObject === undefined ? {} : { unreferencedObject }),
        };
      });
    },

    async linkMessage({ conversationId, messageId, attachmentIds, createdAtMs }) {
      if (
        messageId.length < 1 ||
        messageId.length > 512 ||
        new Set(attachmentIds).size !== attachmentIds.length
      ) {
        throw new ChatAttachmentInvariantError(
          "invalid_message_reference",
          "message attachment reference is invalid",
        );
      }
      integer(createdAtMs, "created_at_ms");
      await store.transaction(async () => {
        for (const [ordinal, attachmentId] of attachmentIds.entries()) {
          const row = await store.get(
            "SELECT 1 AS present FROM chat_attachment WHERE id=? AND conversation_id=?",
            [attachmentId, conversationId],
          );
          if (row === undefined)
            throw new ChatAttachmentInvariantError(
              "attachment_missing",
              "message attachment is missing",
            );
          await store.run(
            `INSERT INTO chat_message_attachment(message_id,conversation_id,attachment_id,ordinal,created_at_ms)
             VALUES (?,?,?,?,?) ON CONFLICT(message_id,attachment_id) DO NOTHING`,
            [messageId, conversationId, attachmentId, ordinal, createdAtMs],
          );
          const linked = await store.get(
            `UPDATE chat_attachment SET message_id=?,updated_at_ms=MAX(updated_at_ms,?)
              WHERE id=? AND conversation_id=? AND (message_id IS NULL OR message_id=?)
              RETURNING ${ATTACHMENT_COLUMNS}`,
            [messageId, createdAtMs, attachmentId, conversationId, messageId],
          );
          if (linked === undefined) {
            throw new ChatAttachmentInvariantError(
              "attachment_message_conflict",
              "attachment is already linked to another message",
            );
          }
        }
      });
    },

    async transitionAttachment({
      conversationId,
      attachmentId,
      from,
      to,
      stateJson,
      messageId,
      updatedAtMs,
    }) {
      if (
        conversationId.length < 1 ||
        conversationId.length > 512 ||
        !SAFE_ID.test(attachmentId) ||
        !STATUSES.has(to) ||
        from.length === 0 ||
        from.some((status) => !STATUSES.has(status)) ||
        new Set(from).size !== from.length ||
        (messageId !== null && (messageId.length < 1 || messageId.length > 512))
      ) {
        throw new ChatAttachmentInvariantError(
          "invalid_attachment_transition",
          "attachment transition is invalid",
        );
      }
      if (stateJson !== null) {
        try {
          JSON.parse(stateJson);
        } catch {
          throw new ChatAttachmentInvariantError(
            "invalid_state_json",
            "attachment state is invalid JSON",
          );
        }
      }
      integer(updatedAtMs, "updated_at_ms");
      return store.transaction(async () => {
        const selected = await store.get(
          `SELECT ${ATTACHMENT_COLUMNS} FROM chat_attachment WHERE id=? AND conversation_id=?`,
          [attachmentId, conversationId],
        );
        if (selected === undefined) {
          throw new ChatAttachmentInvariantError("attachment_missing", "attachment is missing");
        }
        const current = mapAttachment(selected);
        if (current.status === to) {
          if (current.state_json !== stateJson || current.message_id !== messageId) {
            throw new ChatAttachmentInvariantError(
              "attachment_replay_conflict",
              "attachment transition replay conflicts with durable state",
            );
          }
          return current;
        }
        if (
          !from.includes(current.status) ||
          !STATUS_TRANSITIONS[current.status].has(to) ||
          updatedAtMs < current.updated_at_ms ||
          (current.message_id !== null && current.message_id !== messageId)
        ) {
          throw new ChatAttachmentInvariantError(
            "attachment_transition_conflict",
            "attachment transition conflicts with durable state",
          );
        }
        const updated = await store.get(
          `UPDATE chat_attachment SET status=?,state_json=?,message_id=?,updated_at_ms=?
            WHERE id=? AND conversation_id=? AND status=? AND updated_at_ms=?
            RETURNING ${ATTACHMENT_COLUMNS}`,
          [
            to,
            stateJson,
            messageId,
            updatedAtMs,
            attachmentId,
            conversationId,
            current.status,
            current.updated_at_ms,
          ],
        );
        if (updated === undefined) {
          throw new ChatAttachmentInvariantError(
            "attachment_transition_conflict",
            "attachment changed during transition",
          );
        }
        return mapAttachment(updated);
      });
    },

    async updateReadyProjection({ conversationId, attachmentId, stateJson, updatedAtMs }) {
      if (conversationId.length < 1 || conversationId.length > 512 || !SAFE_ID.test(attachmentId)) {
        throw new ChatAttachmentInvariantError(
          "invalid_attachment_projection",
          "attachment projection update is invalid",
        );
      }
      try {
        JSON.parse(stateJson);
      } catch {
        throw new ChatAttachmentInvariantError(
          "invalid_state_json",
          "attachment state is invalid JSON",
        );
      }
      integer(updatedAtMs, "updated_at_ms");
      return store.transaction(async () => {
        const selected = await store.get(
          `SELECT ${ATTACHMENT_COLUMNS} FROM chat_attachment WHERE id=? AND conversation_id=?`,
          [attachmentId, conversationId],
        );
        if (selected === undefined) {
          throw new ChatAttachmentInvariantError("attachment_missing", "attachment is missing");
        }
        const current = mapAttachment(selected);
        if (
          current.status !== "ready" ||
          current.message_id !== null ||
          updatedAtMs < current.updated_at_ms
        ) {
          throw new ChatAttachmentInvariantError(
            "attachment_projection_conflict",
            "attachment projection update conflicts with durable state",
          );
        }
        if (current.state_json === stateJson) return current;
        const updated = await store.get(
          `UPDATE chat_attachment SET state_json=?,updated_at_ms=?
             WHERE id=? AND conversation_id=? AND status='ready' AND message_id IS NULL AND updated_at_ms=?
             RETURNING ${ATTACHMENT_COLUMNS}`,
          [stateJson, updatedAtMs, attachmentId, conversationId, current.updated_at_ms],
        );
        if (updated === undefined) {
          throw new ChatAttachmentInvariantError(
            "attachment_projection_conflict",
            "attachment changed during projection update",
          );
        }
        return mapAttachment(updated);
      });
    },

    async listMessageAttachments(messageId) {
      return (
        await store.all(
          `SELECT ${ATTACHMENT_COLUMNS.split(",")
            .map((column) => `a.${column}`)
            .join(",")}
           FROM chat_message_attachment r JOIN chat_attachment a ON a.id=r.attachment_id
          WHERE r.message_id=? ORDER BY r.ordinal ASC`,
          [messageId],
        )
      ).map(mapAttachment);
    },

    async listObjects() {
      return (
        await store.all(
          `SELECT ${OBJECT_COLUMNS} FROM chat_attachment_object ORDER BY created_at_ms,id`,
        )
      ).map(mapObject);
    },

    async markObjectMissing(objectId, updatedAtMs) {
      await this.failObject(objectId, "managed_bytes_missing", updatedAtMs);
    },

    async cleanupConversation(conversationId) {
      return store.transaction(async () => {
        const objects = (
          await store.all(
            `SELECT ${OBJECT_COLUMNS} FROM chat_attachment_object WHERE conversation_id=? ORDER BY created_at_ms,id`,
            [conversationId],
          )
        ).map(mapObject);
        await store.run("DELETE FROM chat_message_attachment WHERE conversation_id=?", [
          conversationId,
        ]);
        await store.run("DELETE FROM chat_attachment_draft WHERE conversation_id=?", [
          conversationId,
        ]);
        await store.run("DELETE FROM chat_attachment WHERE conversation_id=?", [conversationId]);
        await store.run("DELETE FROM chat_attachment_object WHERE conversation_id=?", [
          conversationId,
        ]);
        return objects;
      });
    },

    async hasObject(objectId) {
      return (
        (await store.get("SELECT 1 AS present FROM chat_attachment_object WHERE id=?", [
          objectId,
        ])) !== undefined
      );
    },

    async deleteFailedObject(objectId) {
      await store.run(
        `DELETE FROM chat_attachment_object WHERE id=? AND status='failed'
          AND NOT EXISTS (SELECT 1 FROM chat_attachment WHERE object_id=?)`,
        [objectId, objectId],
      );
    },
  };
}
