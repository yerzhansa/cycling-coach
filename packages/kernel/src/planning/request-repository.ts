import { canonicalJson } from "../archive/canonical.js";
import { toHex } from "../archive/paths.js";
import type { CryptoPort } from "../ports/crypto.js";
import { encodeUtf8Strict } from "../store/derived-key.js";
import type { MigratorStore } from "../store/migrator.js";
import type { Row, SqlStore } from "../store/ports.js";
import { addCivilDays, dateKeyFromText } from "./date-keys.js";
import { PlanningRequestStoreError } from "./request-errors.js";
import { completePlanningRequestInTransaction } from "./request-transaction.js";

export { PlanningRequestStoreError, type PlanningRequestStoreErrorCode } from "./request-errors.js";

export type PlanningRequestKind =
  | "workout_review"
  | "plan_question"
  | "plan_change"
  | "plan_creation";
export type PlanningRequestTarget = "active_plan" | "draft" | "plan_creation";
export type PlanningRequestLifecycle = "open" | "applied" | "rejected" | "ended";
export type PlanningRequestAttention =
  | "none"
  | "needs_review"
  | "date_conflict"
  | "revalidating"
  | "stale_base"
  | "apply_failed";
export type PlanningRequestSourceStatus = "linked" | "detached_open" | "compacted";
export type PlanningRequestTombstoneStatus = "applied" | "rejected" | "ended" | "source_deleted";

export type PlanningRequestJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly PlanningRequestJsonValue[]
  | { readonly [key: string]: PlanningRequestJsonValue };

export interface PlanningRequestSourceIdentity {
  readonly chatId: string;
  readonly messageId: string;
  readonly attachmentId?: string;
}

export interface PlanningRequestAttachmentSnapshot {
  readonly attachmentId: string;
  readonly displayName: string;
  readonly extension: "zwo" | "mrc" | "erg";
}

export interface PlanningRequestWorkoutSnapshot {
  readonly setId: string;
  readonly workoutId: string;
  readonly workout: { readonly [key: string]: PlanningRequestJsonValue };
}

export interface PlanningRequestSourceSnapshot {
  readonly capturedAt: string;
  readonly attachment: PlanningRequestAttachmentSnapshot | null;
  readonly selectedWorkout: PlanningRequestWorkoutSnapshot | null;
}

export interface CreatePlanningRequestPayload {
  readonly requestId: string;
  readonly kind: PlanningRequestKind;
  readonly intent: string;
  readonly source: PlanningRequestSourceIdentity;
  readonly sourceSnapshot: PlanningRequestSourceSnapshot;
  readonly requestedDate?: string;
}

export interface PlanningRequestProvenanceSnapshot {
  readonly requestId: string;
  readonly kind: PlanningRequestKind;
  readonly intentSummary: string;
  readonly source: {
    readonly chatId: string;
    readonly messageId: string;
    readonly sourceDeleted: boolean;
  };
  readonly attachment: PlanningRequestAttachmentSnapshot | null;
  readonly workout: {
    readonly setId: string;
    readonly workoutId: string;
    readonly name: string;
    readonly sport: string;
    readonly durationSeconds: number;
  } | null;
  readonly capturedAt: string;
}

interface PlanningRequestTerminalBase {
  readonly resultId: string;
  readonly completedAtMs: number;
  readonly title: string;
  readonly detail: string;
  readonly workoutRef: {
    readonly setId: string;
    readonly workoutId: string;
  } | null;
}

export type PlanningRequestTerminalResult =
  | (PlanningRequestTerminalBase & {
      readonly kind: "applied";
      readonly planRevisionId: string;
    })
  | (PlanningRequestTerminalBase & {
      readonly kind: "rejected" | "ended";
      readonly planRevisionId: string | null;
    });

export interface PlanningRequestTombstone {
  readonly requestId: string;
  readonly payloadHash: string;
  readonly status: PlanningRequestTombstoneStatus;
  readonly createdAtMs: number;
  readonly terminalAtMs: number | null;
}

export interface PlanningRequestReadModel {
  readonly requestId: string;
  readonly kind: PlanningRequestKind;
  readonly target: PlanningRequestTarget;
  readonly intent: string;
  readonly planConversationId: string | null;
  readonly proposalId: string | null;
  readonly requestedDateKey: number | null;
  readonly resolvedDateKey: number | null;
  readonly source: {
    readonly chatId: string;
    readonly messageId: string;
    readonly available: boolean;
  };
  readonly lifecycle: PlanningRequestLifecycle;
  readonly attention: PlanningRequestAttention;
  readonly revision: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly terminalResult: PlanningRequestTerminalResult | null;
}

export interface PlanningRequestRecord {
  readonly request: PlanningRequestReadModel;
  readonly payloadHash: string;
  readonly sourceState: {
    readonly status: PlanningRequestSourceStatus;
    readonly identity: PlanningRequestSourceIdentity;
    readonly payload: CreatePlanningRequestPayload | null;
    readonly provenance: PlanningRequestProvenanceSnapshot | null;
  };
  readonly tombstone: PlanningRequestTombstone | null;
}

export interface CreatePlanningRequestInput {
  readonly payload: CreatePlanningRequestPayload;
  readonly target: PlanningRequestTarget;
  readonly createdAtMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface ReviseOpenPlanningRequestInput {
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly planConversationId: string | null;
  readonly proposalId: string | null;
  readonly attention: PlanningRequestAttention;
  readonly resolvedDateKey: number | null;
  readonly updatedAtMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface CompletePlanningRequestInput {
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly result: PlanningRequestTerminalResult;
  readonly resolvedDateKey: number | null;
  readonly updatedAtMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface DetachPlanningRequestSourceInput {
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly provenance: PlanningRequestProvenanceSnapshot;
  readonly updatedAtMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface CompactPlanningRequestSourceInput {
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly updatedAtMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface PlanningRequestRepository {
  createOrGet(input: CreatePlanningRequestInput): Promise<PlanningRequestRecord>;
  read(requestId: string): Promise<PlanningRequestRecord | undefined>;
  readByProposalId(proposalId: string): Promise<PlanningRequestRecord | undefined>;
  readOpen(): Promise<readonly PlanningRequestRecord[]>;
  reviseOpen(input: ReviseOpenPlanningRequestInput): Promise<PlanningRequestRecord>;
  complete(input: CompletePlanningRequestInput): Promise<PlanningRequestRecord>;
  detachSource(input: DetachPlanningRequestSourceInput): Promise<PlanningRequestRecord>;
  compactSource(input: CompactPlanningRequestSourceInput): Promise<PlanningRequestRecord>;
}

type PlanningStore = SqlStore & Pick<MigratorStore, "transaction">;

const ID = /^.{1,512}$/su;
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const KINDS = new Set<unknown>(["workout_review", "plan_question", "plan_change", "plan_creation"]);
const TARGETS = new Set<unknown>(["active_plan", "draft", "plan_creation"]);
const LIFECYCLES = new Set<unknown>(["open", "applied", "rejected", "ended"]);
const ATTENTIONS = new Set<unknown>([
  "none",
  "needs_review",
  "date_conflict",
  "revalidating",
  "stale_base",
  "apply_failed",
]);
const SOURCE_STATUSES = new Set<unknown>(["linked", "detached_open", "compacted"]);
const TOMBSTONE_STATUSES = new Set<unknown>(["applied", "rejected", "ended", "source_deleted"]);
const WORKOUT_EXTENSIONS = new Set<unknown>(["zwo", "mrc", "erg"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is PlanningRequestJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validDateText(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  try {
    dateKeyFromText(value);
    return true;
  } catch {
    return false;
  }
}

function validDateKey(value: number | null): boolean {
  if (value === null) return true;
  try {
    addCivilDays(value, 0);
    return true;
  } catch {
    return false;
  }
}

function validClock(input: {
  readonly createdAtMs?: number;
  readonly updatedAtMs?: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}): boolean {
  return (
    (input.createdAtMs === undefined ||
      (Number.isSafeInteger(input.createdAtMs) && input.createdAtMs >= 0)) &&
    (input.updatedAtMs === undefined ||
      (Number.isSafeInteger(input.updatedAtMs) && input.updatedAtMs >= 0)) &&
    DEVICE_ID.test(input.deviceId) &&
    Number.isSafeInteger(input.hlcPhysicalMs) &&
    input.hlcPhysicalMs >= 0 &&
    Number.isSafeInteger(input.hlcCounter) &&
    input.hlcCounter >= 0
  );
}

function parseAttachmentSnapshot(value: unknown): PlanningRequestAttachmentSnapshot | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !["attachmentId", "displayName", "extension"].includes(key)) ||
    !validId(value.attachmentId) ||
    typeof value.displayName !== "string" ||
    value.displayName.length < 1 ||
    value.displayName.length > 512 ||
    !WORKOUT_EXTENSIONS.has(value.extension)
  ) {
    throw new PlanningRequestStoreError("invalid-create");
  }
  return {
    attachmentId: value.attachmentId,
    displayName: value.displayName,
    extension: value.extension as PlanningRequestAttachmentSnapshot["extension"],
  };
}

function parseWorkoutSnapshot(value: unknown): PlanningRequestWorkoutSnapshot | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !["setId", "workoutId", "workout"].includes(key)) ||
    !validId(value.setId) ||
    !validId(value.workoutId) ||
    !isRecord(value.workout) ||
    !isJsonValue(value.workout)
  ) {
    throw new PlanningRequestStoreError("invalid-create");
  }
  return {
    setId: value.setId,
    workoutId: value.workoutId,
    workout: value.workout as PlanningRequestWorkoutSnapshot["workout"],
  };
}

export function parseCreatePlanningRequestPayload(value: unknown): CreatePlanningRequestPayload {
  if (!isRecord(value)) throw new PlanningRequestStoreError("invalid-create");
  const allowed = new Set([
    "requestId",
    "kind",
    "intent",
    "source",
    "sourceSnapshot",
    "requestedDate",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new PlanningRequestStoreError("invalid-create");
  }
  if (
    !validId(value.requestId) ||
    !KINDS.has(value.kind) ||
    typeof value.intent !== "string" ||
    value.intent.length < 1 ||
    value.intent.length > 20_000 ||
    !isRecord(value.source) ||
    Object.keys(value.source).some(
      (key) => !["chatId", "messageId", "attachmentId"].includes(key),
    ) ||
    !validId(value.source.chatId) ||
    !validId(value.source.messageId) ||
    (value.source.attachmentId !== undefined && !validId(value.source.attachmentId)) ||
    !isRecord(value.sourceSnapshot) ||
    Object.keys(value.sourceSnapshot).some(
      (key) => !["capturedAt", "attachment", "selectedWorkout"].includes(key),
    ) ||
    !validTimestamp(value.sourceSnapshot.capturedAt) ||
    value.sourceSnapshot.capturedAt.length > 128 ||
    value.sourceSnapshot.attachment === undefined ||
    value.sourceSnapshot.selectedWorkout === undefined ||
    (value.requestedDate !== undefined && !validDateText(value.requestedDate))
  ) {
    throw new PlanningRequestStoreError("invalid-create");
  }
  const attachment = parseAttachmentSnapshot(value.sourceSnapshot.attachment);
  const selectedWorkout = parseWorkoutSnapshot(value.sourceSnapshot.selectedWorkout);
  if (
    (value.kind === "workout_review" &&
      (selectedWorkout === null || value.source.attachmentId === undefined)) ||
    (selectedWorkout !== null && attachment === null) ||
    value.source.attachmentId !== attachment?.attachmentId
  ) {
    throw new PlanningRequestStoreError("invalid-create");
  }
  const source: PlanningRequestSourceIdentity = {
    chatId: value.source.chatId,
    messageId: value.source.messageId,
    ...(value.source.attachmentId === undefined ? {} : { attachmentId: value.source.attachmentId }),
  };
  return {
    requestId: value.requestId,
    kind: value.kind as PlanningRequestKind,
    intent: value.intent,
    source,
    sourceSnapshot: {
      capturedAt: value.sourceSnapshot.capturedAt,
      attachment,
      selectedWorkout,
    },
    ...(value.requestedDate === undefined ? {} : { requestedDate: value.requestedDate }),
  };
}

export function parsePlanningRequestProvenance(value: unknown): PlanningRequestProvenanceSnapshot {
  if (!isRecord(value)) throw new PlanningRequestStoreError("invalid-provenance");
  const allowed = new Set([
    "requestId",
    "kind",
    "intentSummary",
    "source",
    "attachment",
    "workout",
    "capturedAt",
  ]);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    !validId(value.requestId) ||
    !KINDS.has(value.kind) ||
    typeof value.intentSummary !== "string" ||
    value.intentSummary.length < 1 ||
    value.intentSummary.length > 2_000 ||
    !isRecord(value.source) ||
    Object.keys(value.source).some(
      (key) => !["chatId", "messageId", "sourceDeleted"].includes(key),
    ) ||
    !validId(value.source.chatId) ||
    !validId(value.source.messageId) ||
    typeof value.source.sourceDeleted !== "boolean" ||
    value.attachment === undefined ||
    value.workout === undefined ||
    !validTimestamp(value.capturedAt) ||
    value.capturedAt.length > 128
  ) {
    throw new PlanningRequestStoreError("invalid-provenance");
  }
  let attachment: PlanningRequestAttachmentSnapshot | null;
  try {
    attachment = parseAttachmentSnapshot(value.attachment);
  } catch {
    throw new PlanningRequestStoreError("invalid-provenance");
  }
  let workout: PlanningRequestProvenanceSnapshot["workout"];
  if (value.workout === null) {
    workout = null;
  } else if (
    isRecord(value.workout) &&
    !Object.keys(value.workout).some(
      (key) => !["setId", "workoutId", "name", "sport", "durationSeconds"].includes(key),
    ) &&
    validId(value.workout.setId) &&
    validId(value.workout.workoutId) &&
    typeof value.workout.name === "string" &&
    value.workout.name.length >= 1 &&
    value.workout.name.length <= 512 &&
    typeof value.workout.sport === "string" &&
    value.workout.sport.length >= 1 &&
    value.workout.sport.length <= 64 &&
    Number.isSafeInteger(value.workout.durationSeconds) &&
    (value.workout.durationSeconds as number) > 0
  ) {
    workout = {
      setId: value.workout.setId,
      workoutId: value.workout.workoutId,
      name: value.workout.name,
      sport: value.workout.sport,
      durationSeconds: value.workout.durationSeconds as number,
    };
  } else {
    throw new PlanningRequestStoreError("invalid-provenance");
  }
  return {
    requestId: value.requestId,
    kind: value.kind as PlanningRequestKind,
    intentSummary: value.intentSummary,
    source: {
      chatId: value.source.chatId,
      messageId: value.source.messageId,
      sourceDeleted: value.source.sourceDeleted,
    },
    attachment,
    workout,
    capturedAt: value.capturedAt,
  };
}

export function parsePlanningRequestTerminalResult(value: unknown): PlanningRequestTerminalResult {
  if (!isRecord(value)) throw new PlanningRequestStoreError("invalid-terminal-result");
  const allowed = new Set([
    "kind",
    "resultId",
    "completedAtMs",
    "title",
    "detail",
    "workoutRef",
    "planRevisionId",
  ]);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    !["applied", "rejected", "ended"].includes(String(value.kind)) ||
    !validId(value.resultId) ||
    !Number.isSafeInteger(value.completedAtMs) ||
    (value.completedAtMs as number) < 0 ||
    typeof value.title !== "string" ||
    value.title.length < 1 ||
    value.title.length > 512 ||
    typeof value.detail !== "string" ||
    value.detail.length < 1 ||
    value.detail.length > 2_000 ||
    value.workoutRef === undefined ||
    value.planRevisionId === undefined
  ) {
    throw new PlanningRequestStoreError("invalid-terminal-result");
  }
  let workoutRef: PlanningRequestTerminalResult["workoutRef"];
  if (value.workoutRef === null) {
    workoutRef = null;
  } else if (
    isRecord(value.workoutRef) &&
    Object.keys(value.workoutRef).every((key) => ["setId", "workoutId"].includes(key)) &&
    validId(value.workoutRef.setId) &&
    validId(value.workoutRef.workoutId)
  ) {
    workoutRef = { setId: value.workoutRef.setId, workoutId: value.workoutRef.workoutId };
  } else {
    throw new PlanningRequestStoreError("invalid-terminal-result");
  }
  if (
    (value.kind === "applied" && !validId(value.planRevisionId)) ||
    (value.kind !== "applied" && value.planRevisionId !== null && !validId(value.planRevisionId))
  ) {
    throw new PlanningRequestStoreError("invalid-terminal-result");
  }
  const base = {
    resultId: value.resultId,
    completedAtMs: value.completedAtMs as number,
    title: value.title,
    detail: value.detail,
    workoutRef,
  };
  if (value.kind === "applied") {
    return { ...base, kind: "applied", planRevisionId: value.planRevisionId as string };
  }
  return {
    ...base,
    kind: value.kind as "rejected" | "ended",
    planRevisionId: value.planRevisionId as string | null,
  };
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new PlanningRequestStoreError("corrupt-record");
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new PlanningRequestStoreError("corrupt-record");
  }
  return value;
}

function nullableText(row: Row, key: string): string | null {
  const value = row[key];
  if (value !== null && typeof value !== "string") {
    throw new PlanningRequestStoreError("corrupt-record");
  }
  return value;
}

function nullableInteger(row: Row, key: string): number | null {
  const value = row[key];
  if (value !== null && (typeof value !== "number" || !Number.isSafeInteger(value))) {
    throw new PlanningRequestStoreError("corrupt-record");
  }
  return value;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new PlanningRequestStoreError("corrupt-record");
  }
}

export function canonicalizeCreatePlanningRequestPayload(value: unknown): string {
  return canonicalJson(parseCreatePlanningRequestPayload(value));
}

export async function hashCreatePlanningRequestPayload(
  crypto: CryptoPort,
  value: unknown,
): Promise<string> {
  return toHex(
    await crypto.sha256(encodeUtf8Strict(canonicalizeCreatePlanningRequestPayload(value))),
  );
}

function validateCreateInput(input: CreatePlanningRequestInput): CreatePlanningRequestPayload {
  const payload = parseCreatePlanningRequestPayload(input.payload);
  if (
    !TARGETS.has(input.target) ||
    !validClock(input) ||
    !Number.isSafeInteger(input.createdAtMs) ||
    input.createdAtMs < 0
  ) {
    throw new PlanningRequestStoreError("invalid-create");
  }
  return payload;
}

function validateMutationClock(
  input: {
    readonly updatedAtMs: number;
    readonly deviceId: string;
    readonly hlcPhysicalMs: number;
    readonly hlcCounter: number;
  },
  current: PlanningRequestRecord,
): void {
  if (!validClock(input) || input.updatedAtMs < current.request.updatedAtMs) {
    throw new PlanningRequestStoreError("invalid-transition");
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function createPlanningRequestRepository(
  store: PlanningStore,
  crypto: CryptoPort,
): PlanningRequestRepository {
  const read = async (requestId: string): Promise<PlanningRequestRecord | undefined> => {
    if (!validId(requestId)) throw new PlanningRequestStoreError("missing-request");
    const row = await store.get("SELECT * FROM planning_request WHERE request_id = ?", [requestId]);
    if (row === undefined) return undefined;
    const terminalRow = await store.get(
      "SELECT * FROM planning_request_terminal_result WHERE request_id = ?",
      [requestId],
    );
    const tombstoneRow = await store.get(
      "SELECT * FROM planning_request_tombstone WHERE request_id = ?",
      [requestId],
    );
    const kind = text(row, "kind") as PlanningRequestKind;
    const target = text(row, "target") as PlanningRequestTarget;
    const lifecycle = text(row, "lifecycle") as PlanningRequestLifecycle;
    const attention = text(row, "attention") as PlanningRequestAttention;
    const sourceStatus = text(row, "source_status") as PlanningRequestSourceStatus;
    const payloadHash = text(row, "payload_hash");
    const payloadJson = nullableText(row, "payload_json");
    const provenanceJson = nullableText(row, "provenance_json");
    const sourceAttachmentId = nullableText(row, "source_attachment_id");
    const sourceIdentity: PlanningRequestSourceIdentity = {
      chatId: text(row, "source_chat_id"),
      messageId: text(row, "source_message_id"),
      ...(sourceAttachmentId === null ? {} : { attachmentId: sourceAttachmentId }),
    };
    if (
      !KINDS.has(kind) ||
      !TARGETS.has(target) ||
      !LIFECYCLES.has(lifecycle) ||
      !ATTENTIONS.has(attention) ||
      !SOURCE_STATUSES.has(sourceStatus) ||
      !SHA256.test(payloadHash)
    ) {
      throw new PlanningRequestStoreError("corrupt-record");
    }
    let payload: CreatePlanningRequestPayload | null = null;
    if (payloadJson !== null) {
      try {
        payload = parseCreatePlanningRequestPayload(parseJson(payloadJson));
      } catch {
        throw new PlanningRequestStoreError("corrupt-record");
      }
      if ((await hashCreatePlanningRequestPayload(crypto, payload)) !== payloadHash) {
        throw new PlanningRequestStoreError("corrupt-record");
      }
    }
    let provenance: PlanningRequestProvenanceSnapshot | null = null;
    if (provenanceJson !== null) {
      try {
        provenance = parsePlanningRequestProvenance(parseJson(provenanceJson));
      } catch {
        throw new PlanningRequestStoreError("corrupt-record");
      }
    }
    let terminalResult: PlanningRequestTerminalResult | null = null;
    if (terminalRow !== undefined) {
      try {
        terminalResult = parsePlanningRequestTerminalResult(
          parseJson(text(terminalRow, "result_json")),
        );
      } catch {
        throw new PlanningRequestStoreError("corrupt-record");
      }
      if (
        terminalResult.resultId !== text(terminalRow, "result_id") ||
        terminalResult.kind !== text(terminalRow, "kind") ||
        terminalResult.completedAtMs !== integer(terminalRow, "completed_at_ms") ||
        terminalResult.planRevisionId !== nullableText(terminalRow, "plan_revision_id")
      ) {
        throw new PlanningRequestStoreError("corrupt-record");
      }
    }
    let tombstone: PlanningRequestTombstone | null = null;
    if (tombstoneRow !== undefined) {
      tombstone = {
        requestId: text(tombstoneRow, "request_id"),
        payloadHash: text(tombstoneRow, "payload_hash"),
        status: text(tombstoneRow, "status") as PlanningRequestTombstoneStatus,
        createdAtMs: integer(tombstoneRow, "created_at_ms"),
        terminalAtMs: nullableInteger(tombstoneRow, "terminal_at_ms"),
      };
      if (
        !TOMBSTONE_STATUSES.has(tombstone.status) ||
        tombstone.requestId !== requestId ||
        tombstone.payloadHash !== payloadHash
      ) {
        throw new PlanningRequestStoreError("corrupt-record");
      }
    }
    const requestedDateKey = nullableInteger(row, "requested_date_key");
    const resolvedDateKey = nullableInteger(row, "resolved_date_key");
    const proposalId = nullableText(row, "proposal_id");
    if (
      !validDateKey(requestedDateKey) ||
      !validDateKey(resolvedDateKey) ||
      (payload === null) !== (sourceStatus === "compacted") ||
      (provenance === null) !== (sourceStatus === "linked") ||
      (sourceStatus === "compacted" && tombstone === null) ||
      (lifecycle === "open") !== (terminalResult === null) ||
      (lifecycle !== "open" && terminalResult?.kind !== lifecycle) ||
      (lifecycle !== "open" && tombstone === null) ||
      (attention !== "none" && (lifecycle !== "open" || proposalId === null)) ||
      (lifecycle !== "open" && attention !== "none") ||
      (payload !== null &&
        (payload.requestId !== requestId ||
          payload.kind !== kind ||
          payload.intent !== text(row, "intent") ||
          !sameJson(payload.source, sourceIdentity) ||
          (payload.requestedDate === undefined
            ? requestedDateKey !== null
            : dateKeyFromText(payload.requestedDate) !== requestedDateKey))) ||
      (provenance !== null &&
        (provenance.requestId !== requestId ||
          provenance.kind !== kind ||
          provenance.source.chatId !== sourceIdentity.chatId ||
          provenance.source.messageId !== sourceIdentity.messageId))
    ) {
      throw new PlanningRequestStoreError("corrupt-record");
    }
    return Object.freeze({
      request: Object.freeze({
        requestId,
        kind,
        target,
        intent: text(row, "intent"),
        planConversationId: nullableText(row, "plan_conversation_id"),
        proposalId,
        requestedDateKey,
        resolvedDateKey,
        source: Object.freeze({
          chatId: sourceIdentity.chatId,
          messageId: sourceIdentity.messageId,
          available: sourceStatus === "linked",
        }),
        lifecycle,
        attention,
        revision: integer(row, "revision"),
        createdAtMs: integer(row, "created_at_ms"),
        updatedAtMs: integer(row, "updated_at_ms"),
        terminalResult,
      }),
      payloadHash,
      sourceState: Object.freeze({
        status: sourceStatus,
        identity: Object.freeze(sourceIdentity),
        payload,
        provenance,
      }),
      tombstone,
    });
  };

  const requireRequest = async (requestId: string): Promise<PlanningRequestRecord> => {
    const record = await read(requestId);
    if (record === undefined) throw new PlanningRequestStoreError("missing-request");
    return record;
  };

  const requireRevision = (record: PlanningRequestRecord, expectedRevision: number): void => {
    if (!Number.isSafeInteger(expectedRevision) || record.request.revision !== expectedRevision) {
      throw new PlanningRequestStoreError("stale-revision");
    }
  };

  return {
    async createOrGet(input) {
      const payload = validateCreateInput(input);
      const payloadJson = canonicalJson(payload);
      const payloadHash = await hashCreatePlanningRequestPayload(crypto, payload);
      return store.transaction(async () => {
        const existing = await read(payload.requestId);
        if (existing !== undefined) {
          if (existing.payloadHash !== payloadHash) {
            throw new PlanningRequestStoreError("request-conflict");
          }
          return existing;
        }
        const requestedDateKey =
          payload.requestedDate === undefined ? null : dateKeyFromText(payload.requestedDate);
        await store.run(
          `INSERT INTO planning_request (
  request_id, kind, target, intent, payload_hash, payload_json, source_status,
  source_chat_id, source_message_id, source_attachment_id, provenance_json,
  plan_conversation_id, proposal_id, requested_date_key, resolved_date_key,
  lifecycle, attention, revision, created_at_ms, updated_at_ms,
  device_id, hlc_physical_ms, hlc_counter
) VALUES (?, ?, ?, ?, ?, ?, 'linked', ?, ?, ?, NULL, NULL, NULL, ?, NULL,
  'open', 'none', 1, ?, ?, ?, ?, ?)`,
          [
            payload.requestId,
            payload.kind,
            input.target,
            payload.intent,
            payloadHash,
            payloadJson,
            payload.source.chatId,
            payload.source.messageId,
            payload.source.attachmentId ?? null,
            requestedDateKey,
            input.createdAtMs,
            input.createdAtMs,
            input.deviceId,
            input.hlcPhysicalMs,
            input.hlcCounter,
          ],
        );
        return requireRequest(payload.requestId);
      });
    },

    read,

    async readByProposalId(proposalId) {
      if (!validId(proposalId)) throw new PlanningRequestStoreError("invalid-transition");
      const rows = await store.all(
        "SELECT request_id FROM planning_request WHERE proposal_id=? ORDER BY request_id ASC",
        [proposalId],
      );
      if (rows.length > 1) throw new PlanningRequestStoreError("corrupt-record");
      const row = rows[0];
      return row === undefined ? undefined : requireRequest(text(row, "request_id"));
    },

    async readOpen() {
      const rows = await store.all(
        "SELECT request_id FROM planning_request WHERE lifecycle = 'open' ORDER BY created_at_ms ASC, request_id ASC",
      );
      const records = await Promise.all(rows.map((row) => requireRequest(text(row, "request_id"))));
      return Object.freeze(records);
    },

    async reviseOpen(input) {
      if (
        !validId(input.requestId) ||
        !ATTENTIONS.has(input.attention) ||
        (input.planConversationId !== null && !validId(input.planConversationId)) ||
        (input.proposalId !== null && !validId(input.proposalId)) ||
        (input.attention !== "none" && input.proposalId === null) ||
        !validDateKey(input.resolvedDateKey)
      ) {
        throw new PlanningRequestStoreError("invalid-transition");
      }
      return store.transaction(async () => {
        const current = await requireRequest(input.requestId);
        requireRevision(current, input.expectedRevision);
        if (current.request.lifecycle !== "open") {
          throw new PlanningRequestStoreError("invalid-transition");
        }
        validateMutationClock(input, current);
        await store.run(
          `UPDATE planning_request SET
  plan_conversation_id = ?, proposal_id = ?, attention = ?, resolved_date_key = ?,
  revision = revision + 1, updated_at_ms = ?, device_id = ?,
  hlc_physical_ms = ?, hlc_counter = ?
WHERE request_id = ? AND lifecycle = 'open' AND revision = ?`,
          [
            input.planConversationId,
            input.proposalId,
            input.attention,
            input.resolvedDateKey,
            input.updatedAtMs,
            input.deviceId,
            input.hlcPhysicalMs,
            input.hlcCounter,
            input.requestId,
            input.expectedRevision,
          ],
        );
        const updated = await requireRequest(input.requestId);
        if (updated.request.revision !== input.expectedRevision + 1) {
          throw new PlanningRequestStoreError("stale-revision");
        }
        return updated;
      });
    },

    async complete(input) {
      if (!validId(input.requestId) || !validDateKey(input.resolvedDateKey)) {
        throw new PlanningRequestStoreError("invalid-terminal-result");
      }
      const result = parsePlanningRequestTerminalResult(input.result);
      return store.transaction(async () => {
        const current = await requireRequest(input.requestId);
        if (current.request.lifecycle !== "open") {
          if (sameJson(current.request.terminalResult, result)) return current;
          throw new PlanningRequestStoreError("immutable-terminal");
        }
        requireRevision(current, input.expectedRevision);
        validateMutationClock(input, current);
        if (
          result.completedAtMs < current.request.createdAtMs ||
          result.completedAtMs > input.updatedAtMs
        ) {
          throw new PlanningRequestStoreError("invalid-terminal-result");
        }
        await completePlanningRequestInTransaction(store, {
          ...input,
          expectedProposalId: current.request.proposalId,
          result,
        });
        const updated = await requireRequest(input.requestId);
        if (updated.request.revision !== input.expectedRevision + 1) {
          throw new PlanningRequestStoreError("stale-revision");
        }
        return updated;
      });
    },

    async detachSource(input) {
      if (!validId(input.requestId)) {
        throw new PlanningRequestStoreError("invalid-provenance");
      }
      const provenance = parsePlanningRequestProvenance(input.provenance);
      if (!provenance.source.sourceDeleted) {
        throw new PlanningRequestStoreError("invalid-provenance");
      }
      return store.transaction(async () => {
        const current = await requireRequest(input.requestId);
        if (current.sourceState.status !== "linked") {
          if (sameJson(current.sourceState.provenance, provenance)) return current;
          throw new PlanningRequestStoreError("invalid-provenance");
        }
        requireRevision(current, input.expectedRevision);
        validateMutationClock(input, current);
        if (
          provenance.requestId !== input.requestId ||
          provenance.kind !== current.request.kind ||
          provenance.source.chatId !== current.sourceState.identity.chatId ||
          provenance.source.messageId !== current.sourceState.identity.messageId
        ) {
          throw new PlanningRequestStoreError("invalid-provenance");
        }
        if (current.tombstone === null) {
          await store.run(
            `INSERT INTO planning_request_tombstone (
  request_id, payload_hash, status, created_at_ms, terminal_at_ms
) VALUES (?, ?, 'source_deleted', ?, NULL)`,
            [input.requestId, current.payloadHash, input.updatedAtMs],
          );
        }
        await store.run(
          `UPDATE planning_request SET
  source_status = 'detached_open', provenance_json = ?, revision = revision + 1,
  updated_at_ms = ?, device_id = ?, hlc_physical_ms = ?, hlc_counter = ?
WHERE request_id = ? AND source_status = 'linked' AND revision = ?`,
          [
            canonicalJson(provenance),
            input.updatedAtMs,
            input.deviceId,
            input.hlcPhysicalMs,
            input.hlcCounter,
            input.requestId,
            input.expectedRevision,
          ],
        );
        const updated = await requireRequest(input.requestId);
        if (updated.request.revision !== input.expectedRevision + 1) {
          throw new PlanningRequestStoreError("stale-revision");
        }
        return updated;
      });
    },

    async compactSource(input) {
      if (!validId(input.requestId)) {
        throw new PlanningRequestStoreError("invalid-transition");
      }
      return store.transaction(async () => {
        const current = await requireRequest(input.requestId);
        if (current.sourceState.status === "compacted") return current;
        requireRevision(current, input.expectedRevision);
        validateMutationClock(input, current);
        if (
          current.request.lifecycle === "open" ||
          current.sourceState.status !== "detached_open" ||
          current.sourceState.provenance === null ||
          current.tombstone === null
        ) {
          throw new PlanningRequestStoreError("invalid-transition");
        }
        await store.run(
          `UPDATE planning_request SET
  source_status = 'compacted', payload_json = NULL, revision = revision + 1,
  updated_at_ms = ?, device_id = ?, hlc_physical_ms = ?, hlc_counter = ?
WHERE request_id = ? AND source_status = 'detached_open' AND lifecycle <> 'open' AND revision = ?`,
          [
            input.updatedAtMs,
            input.deviceId,
            input.hlcPhysicalMs,
            input.hlcCounter,
            input.requestId,
            input.expectedRevision,
          ],
        );
        const updated = await requireRequest(input.requestId);
        if (updated.request.revision !== input.expectedRevision + 1) {
          throw new PlanningRequestStoreError("stale-revision");
        }
        return updated;
      });
    },
  };
}
