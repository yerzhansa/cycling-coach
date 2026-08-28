import type { CryptoPort } from "../ports/crypto.js";
import {
  canonicalizeCreatePlanningRequestPayload,
  hashCreatePlanningRequestPayload,
  parseCreatePlanningRequestPayload,
  type CreatePlanningRequestPayload,
} from "../planning/request-repository.js";
import type { MigratorStore } from "../store/migrator.js";
import type { Row, SqlStore } from "../store/ports.js";

export type ChatPlanOutboxState = "pending" | "failed" | "delivered" | "cancelled";

interface ChatPlanOutboxBase {
  readonly requestId: string;
  readonly payloadHash: string;
  readonly attemptCount: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export type ChatPlanOutboxRecord =
  | (ChatPlanOutboxBase & {
      readonly state: "pending";
      readonly payload: CreatePlanningRequestPayload;
    })
  | (ChatPlanOutboxBase & {
      readonly state: "failed";
      readonly payload: CreatePlanningRequestPayload;
      readonly failureCode: string;
      readonly retryable: boolean;
    })
  | (ChatPlanOutboxBase & {
      readonly state: "delivered";
      readonly payload: CreatePlanningRequestPayload | null;
      readonly deliveredAtMs: number;
      readonly sourceDeletedAtMs: number | null;
    })
  | (ChatPlanOutboxBase & {
      readonly state: "cancelled";
      readonly payload: null;
      readonly cancelledAtMs: number;
      readonly cancelReason: "source_conversation_deleted";
    });

export interface CreateChatPlanOutboxInput {
  readonly payload: CreatePlanningRequestPayload;
  readonly createdAtMs: number;
}

export interface BeginChatPlanDeliveryInput {
  readonly requestId: string;
  readonly attemptedAtMs: number;
}

export interface FailChatPlanDeliveryInput {
  readonly requestId: string;
  readonly failureCode: string;
  readonly retryable: boolean;
  readonly failedAtMs: number;
}

export interface DeliverChatPlanOutboxInput {
  readonly requestId: string;
  readonly deliveredAtMs: number;
}

export interface CancelChatPlanOutboxInput {
  readonly requestId: string;
  readonly cancelledAtMs: number;
}

export interface DetachDeliveredChatPlanSourceInput {
  readonly requestId: string;
  readonly sourceDeletedAtMs: number;
}

export interface ChatPlanOutboxRepository {
  createOrGet(input: CreateChatPlanOutboxInput): Promise<ChatPlanOutboxRecord>;
  read(requestId: string): Promise<ChatPlanOutboxRecord | undefined>;
  readByChatId(chatId: string): Promise<readonly ChatPlanOutboxRecord[]>;
  readRecoverable(): Promise<readonly ChatPlanOutboxRecord[]>;
  beginDelivery(input: BeginChatPlanDeliveryInput): Promise<ChatPlanOutboxRecord>;
  markFailed(input: FailChatPlanDeliveryInput): Promise<ChatPlanOutboxRecord>;
  markDelivered(input: DeliverChatPlanOutboxInput): Promise<ChatPlanOutboxRecord>;
  cancelUndelivered(input: CancelChatPlanOutboxInput): Promise<ChatPlanOutboxRecord>;
  detachDeliveredSource(input: DetachDeliveredChatPlanSourceInput): Promise<ChatPlanOutboxRecord>;
}

export type ChatPlanOutboxStoreErrorCode =
  | "invalid-create"
  | "request-conflict"
  | "missing-outbox"
  | "invalid-transition"
  | "non-retryable"
  | "corrupt-record";

export class ChatPlanOutboxStoreError extends Error {
  readonly code: ChatPlanOutboxStoreErrorCode;

  constructor(code: ChatPlanOutboxStoreErrorCode) {
    super(`chat plan outbox rejected: ${code}`);
    this.name = "ChatPlanOutboxStoreError";
    this.code = code;
  }
}

type ChatPlanOutboxStore = SqlStore & Pick<MigratorStore, "transaction">;

const ID = /^.{1,512}$/su;
const SHA256 = /^[0-9a-f]{64}$/u;
const FAILURE_CODE = /^.{1,128}$/su;

function validId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

function validInstant(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new ChatPlanOutboxStoreError("corrupt-record");
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ChatPlanOutboxStoreError("corrupt-record");
  }
  return value;
}

function nullableText(row: Row, key: string): string | null {
  const value = row[key];
  if (value !== null && typeof value !== "string") {
    throw new ChatPlanOutboxStoreError("corrupt-record");
  }
  return value;
}

function nullableInteger(row: Row, key: string): number | null {
  const value = row[key];
  if (value !== null && (typeof value !== "number" || !Number.isSafeInteger(value))) {
    throw new ChatPlanOutboxStoreError("corrupt-record");
  }
  return value;
}

function nullableBoolean(row: Row, key: string): boolean | null {
  const value = nullableInteger(row, key);
  if (value === null) return null;
  if (value !== 0 && value !== 1) throw new ChatPlanOutboxStoreError("corrupt-record");
  return value === 1;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new ChatPlanOutboxStoreError("corrupt-record");
  }
}

async function mapRow(crypto: CryptoPort, row: Row): Promise<ChatPlanOutboxRecord> {
  const requestId = text(row, "request_id");
  const state = text(row, "state") as ChatPlanOutboxState;
  const payloadHash = text(row, "payload_hash");
  const payloadJson = nullableText(row, "payload_json");
  const attemptCount = integer(row, "attempt_count");
  const failureCode = nullableText(row, "failure_code");
  const retryable = nullableBoolean(row, "retryable");
  const deliveredAtMs = nullableInteger(row, "delivered_at_ms");
  const sourceDeletedAtMs = nullableInteger(row, "source_deleted_at_ms");
  const cancelledAtMs = nullableInteger(row, "cancelled_at_ms");
  const cancelReason = nullableText(row, "cancel_reason");
  const createdAtMs = integer(row, "created_at_ms");
  const updatedAtMs = integer(row, "updated_at_ms");
  if (
    !validId(requestId) ||
    !SHA256.test(payloadHash) ||
    attemptCount < 0 ||
    !validInstant(createdAtMs) ||
    !validInstant(updatedAtMs) ||
    updatedAtMs < createdAtMs
  ) {
    throw new ChatPlanOutboxStoreError("corrupt-record");
  }
  let payload: CreatePlanningRequestPayload | null = null;
  if (payloadJson !== null) {
    try {
      payload = parseCreatePlanningRequestPayload(parseJson(payloadJson));
    } catch {
      throw new ChatPlanOutboxStoreError("corrupt-record");
    }
    if (
      payload.requestId !== requestId ||
      (await hashCreatePlanningRequestPayload(crypto, payload)) !== payloadHash
    ) {
      throw new ChatPlanOutboxStoreError("corrupt-record");
    }
  }
  const base: ChatPlanOutboxBase = Object.freeze({
    requestId,
    payloadHash,
    attemptCount,
    createdAtMs,
    updatedAtMs,
  });
  if (state === "pending") {
    if (
      payload === null ||
      failureCode !== null ||
      retryable !== null ||
      deliveredAtMs !== null ||
      sourceDeletedAtMs !== null ||
      cancelledAtMs !== null ||
      cancelReason !== null
    ) {
      throw new ChatPlanOutboxStoreError("corrupt-record");
    }
    return Object.freeze({ ...base, state, payload });
  }
  if (state === "failed") {
    if (
      payload === null ||
      attemptCount < 1 ||
      failureCode === null ||
      !FAILURE_CODE.test(failureCode) ||
      retryable === null ||
      deliveredAtMs !== null ||
      sourceDeletedAtMs !== null ||
      cancelledAtMs !== null ||
      cancelReason !== null
    ) {
      throw new ChatPlanOutboxStoreError("corrupt-record");
    }
    return Object.freeze({ ...base, state, payload, failureCode, retryable });
  }
  if (state === "delivered") {
    if (
      attemptCount < 1 ||
      failureCode !== null ||
      retryable !== null ||
      deliveredAtMs === null ||
      !validInstant(deliveredAtMs) ||
      deliveredAtMs < createdAtMs ||
      cancelledAtMs !== null ||
      cancelReason !== null ||
      (sourceDeletedAtMs === null) !== (payload !== null) ||
      (sourceDeletedAtMs !== null &&
        (!validInstant(sourceDeletedAtMs) || sourceDeletedAtMs < deliveredAtMs))
    ) {
      throw new ChatPlanOutboxStoreError("corrupt-record");
    }
    return Object.freeze({ ...base, state, payload, deliveredAtMs, sourceDeletedAtMs });
  }
  if (state === "cancelled") {
    if (
      payload !== null ||
      failureCode !== null ||
      retryable !== null ||
      deliveredAtMs !== null ||
      sourceDeletedAtMs !== null ||
      cancelledAtMs === null ||
      !validInstant(cancelledAtMs) ||
      cancelledAtMs < createdAtMs ||
      cancelReason !== "source_conversation_deleted"
    ) {
      throw new ChatPlanOutboxStoreError("corrupt-record");
    }
    return Object.freeze({ ...base, state, payload: null, cancelledAtMs, cancelReason });
  }
  throw new ChatPlanOutboxStoreError("corrupt-record");
}

function validateMutation(requestId: string, instant: number): void {
  if (!validId(requestId) || !validInstant(instant)) {
    throw new ChatPlanOutboxStoreError("invalid-transition");
  }
}

export function createChatPlanOutboxRepository(
  store: ChatPlanOutboxStore,
  crypto: CryptoPort,
): ChatPlanOutboxRepository {
  const read = async (requestId: string): Promise<ChatPlanOutboxRecord | undefined> => {
    if (!validId(requestId)) throw new ChatPlanOutboxStoreError("missing-outbox");
    const row = await store.get("SELECT * FROM chat_plan_outbox WHERE request_id = ?", [requestId]);
    return row === undefined ? undefined : mapRow(crypto, row);
  };

  const requireRecord = async (requestId: string): Promise<ChatPlanOutboxRecord> => {
    const record = await read(requestId);
    if (record === undefined) throw new ChatPlanOutboxStoreError("missing-outbox");
    return record;
  };

  return {
    async createOrGet(input) {
      if (!validInstant(input.createdAtMs)) {
        throw new ChatPlanOutboxStoreError("invalid-create");
      }
      let payload: CreatePlanningRequestPayload;
      try {
        payload = parseCreatePlanningRequestPayload(input.payload);
      } catch {
        throw new ChatPlanOutboxStoreError("invalid-create");
      }
      const payloadJson = canonicalizeCreatePlanningRequestPayload(payload);
      const payloadHash = await hashCreatePlanningRequestPayload(crypto, payload);
      return store.transaction(async () => {
        const existing = await read(payload.requestId);
        if (existing !== undefined) {
          if (
            existing.payloadHash !== payloadHash ||
            (existing.payload !== null &&
              canonicalizeCreatePlanningRequestPayload(existing.payload) !== payloadJson)
          ) {
            throw new ChatPlanOutboxStoreError("request-conflict");
          }
          return existing;
        }
        await store.run(
          `INSERT INTO chat_plan_outbox (
  request_id, state, payload_json, payload_hash, attempt_count,
  failure_code, retryable, delivered_at_ms, source_deleted_at_ms,
  cancelled_at_ms, cancel_reason, created_at_ms, updated_at_ms
) VALUES (?, 'pending', ?, ?, 0, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
          [payload.requestId, payloadJson, payloadHash, input.createdAtMs, input.createdAtMs],
        );
        return requireRecord(payload.requestId);
      });
    },

    read,

    async readByChatId(chatId) {
      if (!validId(chatId)) throw new ChatPlanOutboxStoreError("missing-outbox");
      const rows = await store.all(
        `SELECT request_id FROM chat_plan_outbox
WHERE payload_json IS NOT NULL
  AND json_extract(payload_json, '$.source.chatId') = ?
ORDER BY created_at_ms ASC, request_id ASC`,
        [chatId],
      );
      return Object.freeze(
        await Promise.all(rows.map((row) => requireRecord(text(row, "request_id")))),
      );
    },

    async readRecoverable() {
      const rows = await store.all(
        `SELECT request_id FROM chat_plan_outbox
WHERE state = 'pending' OR (state = 'failed' AND retryable = 1)
ORDER BY updated_at_ms ASC, request_id ASC`,
      );
      return Object.freeze(
        await Promise.all(rows.map((row) => requireRecord(text(row, "request_id")))),
      );
    },

    async beginDelivery(input) {
      validateMutation(input.requestId, input.attemptedAtMs);
      return store.transaction(async () => {
        const current = await requireRecord(input.requestId);
        if (current.state === "failed" && !current.retryable) {
          throw new ChatPlanOutboxStoreError("non-retryable");
        }
        if (
          (current.state !== "pending" && current.state !== "failed") ||
          input.attemptedAtMs < current.updatedAtMs
        ) {
          throw new ChatPlanOutboxStoreError("invalid-transition");
        }
        await store.run(
          `UPDATE chat_plan_outbox SET
  state = 'pending', attempt_count = attempt_count + 1,
  failure_code = NULL, retryable = NULL, updated_at_ms = ?
WHERE request_id = ? AND state IN ('pending','failed')`,
          [input.attemptedAtMs, input.requestId],
        );
        const updated = await requireRecord(input.requestId);
        if (updated.state !== "pending" || updated.attemptCount !== current.attemptCount + 1) {
          throw new ChatPlanOutboxStoreError("invalid-transition");
        }
        return updated;
      });
    },

    async markFailed(input) {
      validateMutation(input.requestId, input.failedAtMs);
      if (!FAILURE_CODE.test(input.failureCode)) {
        throw new ChatPlanOutboxStoreError("invalid-transition");
      }
      return store.transaction(async () => {
        const current = await requireRecord(input.requestId);
        if (
          current.state === "failed" &&
          current.failureCode === input.failureCode &&
          current.retryable === input.retryable
        ) {
          return current;
        }
        if (
          current.state !== "pending" ||
          current.attemptCount < 1 ||
          input.failedAtMs < current.updatedAtMs
        ) {
          throw new ChatPlanOutboxStoreError("invalid-transition");
        }
        await store.run(
          `UPDATE chat_plan_outbox SET
  state = 'failed', failure_code = ?, retryable = ?, updated_at_ms = ?
WHERE request_id = ? AND state = 'pending' AND attempt_count > 0`,
          [input.failureCode, input.retryable ? 1 : 0, input.failedAtMs, input.requestId],
        );
        return requireRecord(input.requestId);
      });
    },

    async markDelivered(input) {
      validateMutation(input.requestId, input.deliveredAtMs);
      return store.transaction(async () => {
        const current = await requireRecord(input.requestId);
        if (current.state === "delivered") return current;
        if (
          current.state !== "pending" ||
          current.attemptCount < 1 ||
          input.deliveredAtMs < current.updatedAtMs
        ) {
          throw new ChatPlanOutboxStoreError("invalid-transition");
        }
        await store.run(
          `UPDATE chat_plan_outbox SET
  state = 'delivered', delivered_at_ms = ?, updated_at_ms = ?
WHERE request_id = ? AND state = 'pending' AND attempt_count > 0`,
          [input.deliveredAtMs, input.deliveredAtMs, input.requestId],
        );
        return requireRecord(input.requestId);
      });
    },

    async cancelUndelivered(input) {
      validateMutation(input.requestId, input.cancelledAtMs);
      return store.transaction(async () => {
        const current = await requireRecord(input.requestId);
        if (current.state === "cancelled") return current;
        if (
          (current.state !== "pending" && current.state !== "failed") ||
          input.cancelledAtMs < current.updatedAtMs
        ) {
          throw new ChatPlanOutboxStoreError("invalid-transition");
        }
        await store.run(
          `UPDATE chat_plan_outbox SET
  state = 'cancelled', payload_json = NULL, failure_code = NULL, retryable = NULL,
  cancelled_at_ms = ?, cancel_reason = 'source_conversation_deleted', updated_at_ms = ?
WHERE request_id = ? AND state IN ('pending','failed')`,
          [input.cancelledAtMs, input.cancelledAtMs, input.requestId],
        );
        return requireRecord(input.requestId);
      });
    },

    async detachDeliveredSource(input) {
      validateMutation(input.requestId, input.sourceDeletedAtMs);
      return store.transaction(async () => {
        const current = await requireRecord(input.requestId);
        if (current.state === "delivered" && current.sourceDeletedAtMs !== null) return current;
        if (
          current.state !== "delivered" ||
          input.sourceDeletedAtMs < current.updatedAtMs ||
          input.sourceDeletedAtMs < current.deliveredAtMs
        ) {
          throw new ChatPlanOutboxStoreError("invalid-transition");
        }
        await store.run(
          `UPDATE chat_plan_outbox SET
  payload_json = NULL, source_deleted_at_ms = ?, updated_at_ms = ?
WHERE request_id = ? AND state = 'delivered' AND source_deleted_at_ms IS NULL`,
          [input.sourceDeletedAtMs, input.sourceDeletedAtMs, input.requestId],
        );
        return requireRecord(input.requestId);
      });
    },
  };
}
