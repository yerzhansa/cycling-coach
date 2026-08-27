import type { MigratorStore } from "../store/migrator.js";
import type { Row, SqlStore } from "../store/ports.js";
import { inclusiveCivilDays } from "./date-keys.js";

export interface PlanReplacementRecord {
  readonly id: string;
  readonly previousPlanId: string;
  readonly replacementPlanId: string;
  readonly draftRevisionId: string;
  readonly cleanupJobId: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface ApprovePlanReplacementInput {
  readonly id: string;
  readonly previousPlanId: string;
  readonly replacementPlanId: string;
  readonly draftRevisionId: string;
  readonly expectedRevision: number;
  readonly cleanupJobId: string;
  readonly windowStartDateKey: number;
  readonly windowEndDateKey: number;
  readonly updatedAtMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface PlanReplacementRepository {
  approve(input: ApprovePlanReplacementInput): Promise<PlanReplacementRecord>;
  readByPreviousPlanId(planId: string): Promise<PlanReplacementRecord | undefined>;
  readByReplacementPlanId(planId: string): Promise<PlanReplacementRecord | undefined>;
}

export type PlanReplacementValidationErrorCode =
  | "invalid-replacement"
  | "missing-draft"
  | "stale-draft"
  | "invalid-lineage"
  | "old-plan-not-active"
  | "replacement-not-draft";

export class PlanReplacementValidationError extends Error {
  readonly code: PlanReplacementValidationErrorCode;

  constructor(code: PlanReplacementValidationErrorCode) {
    super(`plan replacement rejected: ${code}`);
    this.name = "PlanReplacementValidationError";
    this.code = code;
  }
}

type ReplacementStore = SqlStore & Pick<MigratorStore, "transaction">;

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const COLUMNS = `id,previous_plan_id,replacement_plan_id,draft_revision_id,cleanup_job_id,
created_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter`;

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new PlanReplacementValidationError("invalid-lineage");
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new PlanReplacementValidationError("invalid-lineage");
  }
  return value;
}

function fromRow(row: Row): PlanReplacementRecord {
  const record: PlanReplacementRecord = {
    id: text(row, "id"),
    previousPlanId: text(row, "previous_plan_id"),
    replacementPlanId: text(row, "replacement_plan_id"),
    draftRevisionId: text(row, "draft_revision_id"),
    cleanupJobId: text(row, "cleanup_job_id"),
    createdAtMs: integer(row, "created_at_ms"),
    updatedAtMs: integer(row, "updated_at_ms"),
    deviceId: text(row, "device_id"),
    hlcPhysicalMs: integer(row, "hlc_physical_ms"),
    hlcCounter: integer(row, "hlc_counter"),
  };
  if (
    !ULID.test(record.id) ||
    !ULID.test(record.previousPlanId) ||
    !ULID.test(record.replacementPlanId) ||
    !ULID.test(record.draftRevisionId) ||
    !ULID.test(record.cleanupJobId) ||
    record.previousPlanId === record.replacementPlanId ||
    record.createdAtMs < 0 ||
    record.updatedAtMs < record.createdAtMs ||
    !DEVICE_ID.test(record.deviceId) ||
    record.hlcPhysicalMs < 0 ||
    record.hlcCounter < 0
  ) {
    throw new PlanReplacementValidationError("invalid-lineage");
  }
  return Object.freeze(record);
}

function validateInput(input: ApprovePlanReplacementInput): void {
  if (
    !ULID.test(input.id) ||
    !ULID.test(input.previousPlanId) ||
    !ULID.test(input.replacementPlanId) ||
    !ULID.test(input.draftRevisionId) ||
    !ULID.test(input.cleanupJobId) ||
    input.previousPlanId === input.replacementPlanId ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision <= 0 ||
    inclusiveCivilDays(input.windowStartDateKey, input.windowEndDateKey) <= 0 ||
    !Number.isSafeInteger(input.updatedAtMs) ||
    input.updatedAtMs < 0 ||
    !DEVICE_ID.test(input.deviceId) ||
    !Number.isSafeInteger(input.hlcPhysicalMs) ||
    input.hlcPhysicalMs < 0 ||
    !Number.isSafeInteger(input.hlcCounter) ||
    input.hlcCounter < 0
  ) {
    throw new PlanReplacementValidationError("invalid-replacement");
  }
}

export function createPlanReplacementRepository(
  store: ReplacementStore,
): PlanReplacementRepository {
  const readBy = async (
    column: "previous_plan_id" | "replacement_plan_id",
    planId: string,
  ): Promise<PlanReplacementRecord | undefined> => {
    if (!ULID.test(planId)) throw new PlanReplacementValidationError("invalid-replacement");
    const row = await store.get(`SELECT ${COLUMNS} FROM plan_replacement WHERE ${column}=?`, [
      planId,
    ]);
    return row === undefined ? undefined : fromRow(row);
  };

  const repository: PlanReplacementRepository = {
    async approve(input) {
      validateInput(input);
      return store.transaction(async () => {
        const existing = await readBy("replacement_plan_id", input.replacementPlanId);
        if (existing !== undefined) {
          if (
            existing.previousPlanId !== input.previousPlanId ||
            existing.draftRevisionId !== input.draftRevisionId
          ) {
            throw new PlanReplacementValidationError("invalid-lineage");
          }
          return existing;
        }

        const draft = await store.get("SELECT * FROM plan_draft_revision WHERE id=?", [
          input.draftRevisionId,
        ]);
        if (draft === undefined) throw new PlanReplacementValidationError("missing-draft");
        const conversationId = text(draft, "conversation_id");
        const latest = await store.get(
          "SELECT id FROM plan_draft_revision WHERE conversation_id=? ORDER BY revision DESC,id DESC LIMIT 1",
          [conversationId],
        );
        if (
          latest === undefined ||
          text(latest, "id") !== input.draftRevisionId ||
          integer(draft, "revision") !== input.expectedRevision ||
          text(draft, "status") !== "ready" ||
          text(draft, "plan_id") !== input.replacementPlanId
        ) {
          throw new PlanReplacementValidationError("stale-draft");
        }
        const conversation = await store.get("SELECT * FROM plan_conversation WHERE id=?", [
          conversationId,
        ]);
        if (
          conversation === undefined ||
          text(conversation, "status") !== "open" ||
          text(conversation, "plan_id") !== input.replacementPlanId ||
          text(conversation, "replaces_plan_id") !== input.previousPlanId
        ) {
          throw new PlanReplacementValidationError("invalid-lineage");
        }
        const [previous, replacement] = await Promise.all([
          store.get("SELECT status,updated_at_ms FROM plan WHERE id=?", [input.previousPlanId]),
          store.get("SELECT status,updated_at_ms FROM plan WHERE id=?", [input.replacementPlanId]),
        ]);
        if (previous === undefined || text(previous, "status") !== "active") {
          throw new PlanReplacementValidationError("old-plan-not-active");
        }
        if (replacement === undefined || text(replacement, "status") !== "draft") {
          throw new PlanReplacementValidationError("replacement-not-draft");
        }
        if (
          input.updatedAtMs < integer(previous, "updated_at_ms") ||
          input.updatedAtMs < integer(replacement, "updated_at_ms") ||
          input.updatedAtMs < integer(draft, "updated_at_ms")
        ) {
          throw new PlanReplacementValidationError("stale-draft");
        }

        await store.run(
          `UPDATE plan SET status='ended',updated_at_ms=?,device_id=?,hlc_physical_ms=?,hlc_counter=?
           WHERE id=? AND status='active'`,
          [
            input.updatedAtMs,
            input.deviceId,
            input.hlcPhysicalMs,
            input.hlcCounter,
            input.previousPlanId,
          ],
        );
        await store.run(
          `UPDATE plan SET status='active',updated_at_ms=?,device_id=?,hlc_physical_ms=?,hlc_counter=?
           WHERE id=? AND status='draft'`,
          [
            input.updatedAtMs,
            input.deviceId,
            input.hlcPhysicalMs,
            input.hlcCounter,
            input.replacementPlanId,
          ],
        );
        await store.run(
          `UPDATE plan_draft_revision SET status='approved',updated_at_ms=?,device_id=?,
             hlc_physical_ms=?,hlc_counter=? WHERE id=? AND status='ready'`,
          [
            input.updatedAtMs,
            input.deviceId,
            input.hlcPhysicalMs,
            input.hlcCounter,
            input.draftRevisionId,
          ],
        );
        await store.run(
          `INSERT INTO plan_reconciliation_job (
             id,plan_id,kind,status,window_start_date_key,window_end_date_key,
             attempt_count,failure_count,resumed_count,last_resumed_attempt,last_error_code,
             created_at_ms,updated_at_ms,completed_at_ms
           ) VALUES (?,?,'cleanup','pending',?,?,0,0,0,NULL,NULL,?,?,NULL)`,
          [
            input.cleanupJobId,
            input.previousPlanId,
            input.windowStartDateKey,
            input.windowEndDateKey,
            input.updatedAtMs,
            input.updatedAtMs,
          ],
        );
        await store.run(`INSERT INTO plan_replacement (${COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?)`, [
          input.id,
          input.previousPlanId,
          input.replacementPlanId,
          input.draftRevisionId,
          input.cleanupJobId,
          input.updatedAtMs,
          input.updatedAtMs,
          input.deviceId,
          input.hlcPhysicalMs,
          input.hlcCounter,
        ]);
        const stored = await readBy("replacement_plan_id", input.replacementPlanId);
        if (stored === undefined) throw new PlanReplacementValidationError("invalid-lineage");
        return stored;
      });
    },
    readByPreviousPlanId(planId) {
      return readBy("previous_plan_id", planId);
    },
    readByReplacementPlanId(planId) {
      return readBy("replacement_plan_id", planId);
    },
  };
  return Object.freeze(repository);
}
