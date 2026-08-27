import type { MigratorStore } from "../store/migrator.js";
import type { Row, SqlStore } from "../store/ports.js";
import {
  validatePlanConversationRecord,
  validatePlanDraftRevisionRecord,
  type PlanConversationRecord,
  type PlanDraftRevisionRecord,
} from "./conversation-repository.js";
import {
  validatePlanRecord,
  validatePlanWorkoutRecord,
  type PlanRecord,
  type PlanWorkoutRecord,
} from "./repository.js";

export type PlanDraftBuildOperation = "form" | "revise" | "course" | "start-date";

export interface PlanDraftBuildCheckpointRecord {
  readonly id: string;
  readonly conversationId: string;
  readonly buildKey: string;
  readonly operation: PlanDraftBuildOperation;
  readonly planId: string;
  readonly draftRevisionId: string;
  readonly targetRevision: number;
  readonly completedWeeks: number;
  readonly totalWeeks: number;
  readonly payloadJson: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface CommitReadyPlanDraftInput {
  readonly checkpointId: string;
  readonly conversation: PlanConversationRecord;
  readonly plan: PlanRecord;
  readonly workouts: readonly PlanWorkoutRecord[];
  readonly draft: PlanDraftRevisionRecord;
}

export interface PlanDraftBuildRepository {
  read(conversationId: string): Promise<PlanDraftBuildCheckpointRecord | undefined>;
  save(record: PlanDraftBuildCheckpointRecord): Promise<PlanDraftBuildCheckpointRecord>;
  commitReady(input: CommitReadyPlanDraftInput): Promise<void>;
}

export type PlanDraftBuildValidationErrorCode =
  | "invalid-checkpoint"
  | "missing-conversation"
  | "conversation-conflict"
  | "checkpoint-conflict"
  | "draft-conflict";

export class PlanDraftBuildValidationError extends Error {
  readonly code: PlanDraftBuildValidationErrorCode;

  constructor(code: PlanDraftBuildValidationErrorCode) {
    super(`plan Draft build rejected: ${code}`);
    this.name = "PlanDraftBuildValidationError";
    this.code = code;
  }
}

type PlanningStore = SqlStore & Pick<MigratorStore, "transaction">;

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPERATIONS = new Set<unknown>(["form", "revise", "course", "start-date"]);

function validJson(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function validateCheckpoint(record: PlanDraftBuildCheckpointRecord): void {
  if (
    !ULID.test(record.id) ||
    !ULID.test(record.conversationId) ||
    !ULID.test(record.planId) ||
    !ULID.test(record.draftRevisionId) ||
    typeof record.buildKey !== "string" ||
    record.buildKey.length < 1 ||
    record.buildKey.length > 16_384 ||
    !OPERATIONS.has(record.operation) ||
    !Number.isSafeInteger(record.targetRevision) ||
    record.targetRevision <= 0 ||
    !Number.isSafeInteger(record.completedWeeks) ||
    record.completedWeeks < 0 ||
    !Number.isSafeInteger(record.totalWeeks) ||
    record.totalWeeks <= 0 ||
    record.completedWeeks > record.totalWeeks ||
    !validJson(record.payloadJson) ||
    !Number.isSafeInteger(record.createdAtMs) ||
    record.createdAtMs < 0 ||
    !Number.isSafeInteger(record.updatedAtMs) ||
    record.updatedAtMs < record.createdAtMs ||
    !DEVICE_ID.test(record.deviceId) ||
    !Number.isSafeInteger(record.hlcPhysicalMs) ||
    record.hlcPhysicalMs < 0 ||
    !Number.isSafeInteger(record.hlcCounter) ||
    record.hlcCounter < 0
  ) {
    throw new PlanDraftBuildValidationError("invalid-checkpoint");
  }
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new PlanDraftBuildValidationError("invalid-checkpoint");
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new PlanDraftBuildValidationError("invalid-checkpoint");
  }
  return value;
}

function fromRow(row: Row): PlanDraftBuildCheckpointRecord {
  const record: PlanDraftBuildCheckpointRecord = Object.freeze({
    id: text(row, "id"),
    conversationId: text(row, "conversation_id"),
    buildKey: text(row, "build_key"),
    operation: text(row, "operation") as PlanDraftBuildOperation,
    planId: text(row, "plan_id"),
    draftRevisionId: text(row, "draft_revision_id"),
    targetRevision: integer(row, "target_revision"),
    completedWeeks: integer(row, "completed_weeks"),
    totalWeeks: integer(row, "total_weeks"),
    payloadJson: text(row, "payload_json"),
    createdAtMs: integer(row, "created_at_ms"),
    updatedAtMs: integer(row, "updated_at_ms"),
    deviceId: text(row, "device_id"),
    hlcPhysicalMs: integer(row, "hlc_physical_ms"),
    hlcCounter: integer(row, "hlc_counter"),
  });
  validateCheckpoint(record);
  return record;
}

function sameCheckpointIdentity(
  left: PlanDraftBuildCheckpointRecord,
  right: PlanDraftBuildCheckpointRecord,
): boolean {
  return (
    left.id === right.id &&
    left.conversationId === right.conversationId &&
    left.buildKey === right.buildKey &&
    left.operation === right.operation &&
    left.planId === right.planId &&
    left.draftRevisionId === right.draftRevisionId &&
    left.targetRevision === right.targetRevision &&
    left.totalWeeks === right.totalWeeks &&
    left.createdAtMs === right.createdAtMs
  );
}

export function createPlanDraftBuildRepository(store: PlanningStore): PlanDraftBuildRepository {
  const read = async (
    conversationId: string,
  ): Promise<PlanDraftBuildCheckpointRecord | undefined> => {
    if (!ULID.test(conversationId)) {
      throw new PlanDraftBuildValidationError("invalid-checkpoint");
    }
    const row = await store.get(
      "SELECT * FROM plan_draft_build_checkpoint WHERE conversation_id=?",
      [conversationId],
    );
    return row === undefined ? undefined : fromRow(row);
  };

  return Object.freeze({
    read,
    async save(record: PlanDraftBuildCheckpointRecord) {
      validateCheckpoint(record);
      return store.transaction(async () => {
        const conversation = await store.get("SELECT status FROM plan_conversation WHERE id=?", [
          record.conversationId,
        ]);
        if (conversation === undefined) {
          throw new PlanDraftBuildValidationError("missing-conversation");
        }
        if (text(conversation, "status") !== "open") {
          throw new PlanDraftBuildValidationError("conversation-conflict");
        }
        const existing = await read(record.conversationId);
        if (
          existing !== undefined &&
          existing.buildKey === record.buildKey &&
          (!sameCheckpointIdentity(existing, record) ||
            record.completedWeeks < existing.completedWeeks ||
            record.updatedAtMs < existing.updatedAtMs ||
            record.hlcPhysicalMs < existing.hlcPhysicalMs ||
            (record.hlcPhysicalMs === existing.hlcPhysicalMs &&
              record.hlcCounter <= existing.hlcCounter))
        ) {
          throw new PlanDraftBuildValidationError("checkpoint-conflict");
        }
        if (existing !== undefined && existing.buildKey !== record.buildKey) {
          await store.run("DELETE FROM plan_draft_build_checkpoint WHERE conversation_id=?", [
            record.conversationId,
          ]);
        }
        await store.run(
          `INSERT INTO plan_draft_build_checkpoint (
             id,conversation_id,build_key,operation,plan_id,draft_revision_id,target_revision,
             completed_weeks,total_weeks,payload_json,created_at_ms,updated_at_ms,device_id,
             hlc_physical_ms,hlc_counter
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT (conversation_id) DO UPDATE SET
             completed_weeks=excluded.completed_weeks,
             payload_json=excluded.payload_json,
             updated_at_ms=excluded.updated_at_ms,
             device_id=excluded.device_id,
             hlc_physical_ms=excluded.hlc_physical_ms,
             hlc_counter=excluded.hlc_counter`,
          [
            record.id,
            record.conversationId,
            record.buildKey,
            record.operation,
            record.planId,
            record.draftRevisionId,
            record.targetRevision,
            record.completedWeeks,
            record.totalWeeks,
            record.payloadJson,
            record.createdAtMs,
            record.updatedAtMs,
            record.deviceId,
            record.hlcPhysicalMs,
            record.hlcCounter,
          ],
        );
        const saved = await read(record.conversationId);
        if (saved === undefined) throw new PlanDraftBuildValidationError("checkpoint-conflict");
        return saved;
      });
    },
    async commitReady(input: CommitReadyPlanDraftInput) {
      validatePlanConversationRecord(input.conversation);
      validatePlanRecord(input.plan);
      for (const workout of input.workouts) validatePlanWorkoutRecord(input.plan, workout);
      validatePlanDraftRevisionRecord(input.draft);
      if (
        !ULID.test(input.checkpointId) ||
        input.plan.status !== "draft" ||
        input.conversation.id !== input.draft.conversationId ||
        input.conversation.planId !== input.plan.id ||
        input.draft.planId !== input.plan.id ||
        input.draft.status !== "ready"
      ) {
        throw new PlanDraftBuildValidationError("draft-conflict");
      }
      await store.transaction(async () => {
        const checkpointRow = await store.get(
          "SELECT * FROM plan_draft_build_checkpoint WHERE id=? AND conversation_id=?",
          [input.checkpointId, input.conversation.id],
        );
        if (checkpointRow === undefined) {
          const existingDraft = await store.get(
            "SELECT status FROM plan_draft_revision WHERE id=?",
            [input.draft.id],
          );
          if (existingDraft !== undefined && text(existingDraft, "status") === "ready") return;
          throw new PlanDraftBuildValidationError("checkpoint-conflict");
        }
        const checkpoint = fromRow(checkpointRow);
        if (
          checkpoint.id !== input.checkpointId ||
          checkpoint.planId !== input.plan.id ||
          checkpoint.draftRevisionId !== input.draft.id ||
          checkpoint.targetRevision !== input.draft.revision ||
          checkpoint.completedWeeks !== checkpoint.totalWeeks
        ) {
          throw new PlanDraftBuildValidationError("checkpoint-conflict");
        }
        const conversation = await store.get("SELECT status FROM plan_conversation WHERE id=?", [
          input.conversation.id,
        ]);
        if (conversation === undefined) {
          throw new PlanDraftBuildValidationError("missing-conversation");
        }
        if (text(conversation, "status") !== "open") {
          throw new PlanDraftBuildValidationError("conversation-conflict");
        }
        const latest = await store.get(
          "SELECT id,revision FROM plan_draft_revision WHERE conversation_id=? ORDER BY revision DESC,id DESC LIMIT 1",
          [input.conversation.id],
        );
        if (
          (input.draft.revision === 1 && latest !== undefined) ||
          (input.draft.revision > 1 &&
            (latest === undefined ||
              text(latest, "id") !== input.draft.parentRevisionId ||
              integer(latest, "revision") !== input.draft.revision - 1))
        ) {
          throw new PlanDraftBuildValidationError("draft-conflict");
        }
        const existingPlan = await store.get("SELECT status FROM plan WHERE id=?", [input.plan.id]);
        if (existingPlan !== undefined && text(existingPlan, "status") !== "draft") {
          throw new PlanDraftBuildValidationError("draft-conflict");
        }
        await store.run(
          `INSERT INTO plan (
             id,origin_id,name,primary_goal,start_date_key,target_date_key,status,kind,total_weeks,
             week_start_day,structure_json,created_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT (id) DO UPDATE SET
             origin_id=excluded.origin_id,name=excluded.name,primary_goal=excluded.primary_goal,
             start_date_key=excluded.start_date_key,target_date_key=excluded.target_date_key,
             status=excluded.status,kind=excluded.kind,total_weeks=excluded.total_weeks,
             week_start_day=excluded.week_start_day,structure_json=excluded.structure_json,
             updated_at_ms=excluded.updated_at_ms,device_id=excluded.device_id,
             hlc_physical_ms=excluded.hlc_physical_ms,hlc_counter=excluded.hlc_counter`,
          [
            input.plan.id,
            input.plan.originId,
            input.plan.name,
            input.plan.primaryGoal,
            input.plan.startDateKey,
            input.plan.targetDateKey,
            input.plan.status,
            input.plan.kind,
            input.plan.totalWeeks,
            input.plan.weekStartDay,
            input.plan.structureJson,
            input.plan.createdAtMs,
            input.plan.updatedAtMs,
            input.plan.deviceId,
            input.plan.hlcPhysicalMs,
            input.plan.hlcCounter,
          ],
        );
        await store.run("DELETE FROM plan_workout WHERE plan_id=?", [input.plan.id]);
        for (const workout of input.workouts) {
          await store.run(
            `INSERT INTO plan_workout (
               id,plan_id,date_key,sport,name,duration_s,structure_json,origin,device_id,
               hlc_physical_ms,hlc_counter
             ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            [
              workout.id,
              workout.planId,
              workout.dateKey,
              workout.sport,
              workout.name,
              workout.durationS,
              workout.structureJson,
              workout.origin,
              workout.deviceId,
              workout.hlcPhysicalMs,
              workout.hlcCounter,
            ],
          );
        }
        await store.run(
          `UPDATE plan_conversation SET
             plan_id=?,course_choice_status=?,race_course_json=?,course_failure_json=?,status=?,ended_at_ms=?,
             updated_at_ms=?,device_id=?,hlc_physical_ms=?,hlc_counter=? WHERE id=?`,
          [
            input.conversation.planId,
            input.conversation.courseChoiceStatus,
            input.conversation.raceCourseJson,
            input.conversation.courseFailureJson ?? null,
            input.conversation.status,
            input.conversation.endedAtMs,
            input.conversation.updatedAtMs,
            input.conversation.deviceId,
            input.conversation.hlcPhysicalMs,
            input.conversation.hlcCounter,
            input.conversation.id,
          ],
        );
        await store.run(
          `INSERT INTO plan_draft_revision (
             id,conversation_id,plan_id,revision,parent_revision_id,parent_revision,status,
             snapshot_json,race_course_json,created_at_ms,updated_at_ms,device_id,
             hlc_physical_ms,hlc_counter
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            input.draft.id,
            input.draft.conversationId,
            input.draft.planId,
            input.draft.revision,
            input.draft.parentRevisionId,
            input.draft.parentRevisionId === null ? null : input.draft.revision - 1,
            input.draft.status,
            input.draft.snapshotJson,
            input.draft.raceCourseJson,
            input.draft.createdAtMs,
            input.draft.updatedAtMs,
            input.draft.deviceId,
            input.draft.hlcPhysicalMs,
            input.draft.hlcCounter,
          ],
        );
        await store.run("DELETE FROM plan_draft_build_checkpoint WHERE id=?", [input.checkpointId]);
      });
    },
  });
}
