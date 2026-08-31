import type { MigratorStore } from "../store/migrator.js";
import type { Row, SqlStore } from "../store/ports.js";

export type PlanChangeStatus = "preview" | "applied" | "stale" | "discarded";

export interface PlanChangeRecord {
  readonly id: string;
  readonly planId: string;
  readonly status: PlanChangeStatus;
  readonly version: number;
  readonly baseRevisionNumber: number;
  readonly resultRevisionNumber: number | null;
  readonly diffJson: string;
  readonly rationale: string;
  readonly premisesJson: string;
  readonly previewFingerprint: string;
  readonly reconciliationEffectJson: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly terminalAtMs: number | null;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface CreatePlanChangePreviewInput {
  readonly id: string;
  readonly planId: string;
  readonly baseRevisionNumber: number;
  readonly diffJson: string;
  readonly rationale: string;
  readonly premisesJson: string;
  readonly previewFingerprint: string;
  readonly reconciliationEffectJson: string;
  readonly createdAtMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface TransitionPlanChangeInput {
  readonly id: string;
  readonly expectedVersion: number;
  readonly target: "applied" | "stale" | "discarded";
  readonly resultRevisionNumber: number | null;
  readonly terminalAtMs: number;
  readonly updatedAtMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface PlanChangeRepository {
  createPreview(input: CreatePlanChangePreviewInput): Promise<PlanChangeRecord>;
  read(id: string): Promise<PlanChangeRecord | undefined>;
  readPreview(planId: string): Promise<PlanChangeRecord | undefined>;
  transition(input: TransitionPlanChangeInput): Promise<PlanChangeRecord>;
}

export type PlanChangeStoreErrorCode =
  | "invalid-change"
  | "missing-change"
  | "missing-plan"
  | "change-conflict"
  | "stale-change"
  | "corrupt-record";

export class PlanChangeStoreError extends Error {
  readonly code: PlanChangeStoreErrorCode;

  constructor(code: PlanChangeStoreErrorCode) {
    super(`Plan Change rejected: ${code}`);
    this.name = "PlanChangeStoreError";
    this.code = code;
  }
}

type PlanningStore = SqlStore & Pick<MigratorStore, "transaction">;
type TransactionRunner = <T>(operation: () => Promise<T>) => Promise<T>;

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/u;
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const STATUSES = new Set<unknown>(["preview", "applied", "stale", "discarded"]);
const COLUMNS = `id,plan_id,status,version,base_revision_number,result_revision_number,diff_json,
rationale,premises_json,preview_fingerprint,reconciliation_effect_json,created_at_ms,updated_at_ms,
terminal_at_ms,device_id,hlc_physical_ms,hlc_counter`;

function validJson(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function validClock(value: {
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}): boolean {
  return (
    DEVICE_ID.test(value.deviceId) &&
    Number.isSafeInteger(value.hlcPhysicalMs) &&
    value.hlcPhysicalMs >= 0 &&
    Number.isSafeInteger(value.hlcCounter) &&
    value.hlcCounter >= 0
  );
}

function clockNotBefore(
  next: { readonly hlcPhysicalMs: number; readonly hlcCounter: number },
  current: { readonly hlcPhysicalMs: number; readonly hlcCounter: number },
): boolean {
  return (
    next.hlcPhysicalMs > current.hlcPhysicalMs ||
    (next.hlcPhysicalMs === current.hlcPhysicalMs && next.hlcCounter >= current.hlcCounter)
  );
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new PlanChangeStoreError("corrupt-record");
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new PlanChangeStoreError("corrupt-record");
  }
  return value;
}

function nullableInteger(row: Row, key: string): number | null {
  const value = row[key];
  if (value !== null && (typeof value !== "number" || !Number.isSafeInteger(value))) {
    throw new PlanChangeStoreError("corrupt-record");
  }
  return value;
}

function validate(record: PlanChangeRecord): void {
  const terminal = record.status !== "preview";
  if (
    !ULID.test(record.id) ||
    !ULID.test(record.planId) ||
    !STATUSES.has(record.status) ||
    !Number.isSafeInteger(record.version) ||
    record.version <= 0 ||
    !Number.isSafeInteger(record.baseRevisionNumber) ||
    record.baseRevisionNumber <= 0 ||
    (record.resultRevisionNumber !== null &&
      (!Number.isSafeInteger(record.resultRevisionNumber) || record.resultRevisionNumber <= 0)) ||
    (record.status === "applied" &&
      record.resultRevisionNumber !== record.baseRevisionNumber + 1) ||
    !validJson(record.diffJson) ||
    record.rationale.length < 1 ||
    record.rationale.length > 20_000 ||
    !validJson(record.premisesJson) ||
    !SHA256.test(record.previewFingerprint) ||
    !validJson(record.reconciliationEffectJson) ||
    !Number.isSafeInteger(record.createdAtMs) ||
    record.createdAtMs < 0 ||
    !Number.isSafeInteger(record.updatedAtMs) ||
    record.updatedAtMs < record.createdAtMs ||
    !validClock(record) ||
    terminal !== (record.terminalAtMs !== null) ||
    (record.status === "applied") !== (record.resultRevisionNumber !== null) ||
    (record.terminalAtMs !== null &&
      (!Number.isSafeInteger(record.terminalAtMs) ||
        record.terminalAtMs < record.createdAtMs ||
        record.terminalAtMs > record.updatedAtMs))
  ) {
    throw new PlanChangeStoreError("invalid-change");
  }
}

function fromRow(row: Row): PlanChangeRecord {
  const record: PlanChangeRecord = Object.freeze({
    id: text(row, "id"),
    planId: text(row, "plan_id"),
    status: text(row, "status") as PlanChangeStatus,
    version: integer(row, "version"),
    baseRevisionNumber: integer(row, "base_revision_number"),
    resultRevisionNumber: nullableInteger(row, "result_revision_number"),
    diffJson: text(row, "diff_json"),
    rationale: text(row, "rationale"),
    premisesJson: text(row, "premises_json"),
    previewFingerprint: text(row, "preview_fingerprint"),
    reconciliationEffectJson: text(row, "reconciliation_effect_json"),
    createdAtMs: integer(row, "created_at_ms"),
    updatedAtMs: integer(row, "updated_at_ms"),
    terminalAtMs: nullableInteger(row, "terminal_at_ms"),
    deviceId: text(row, "device_id"),
    hlcPhysicalMs: integer(row, "hlc_physical_ms"),
    hlcCounter: integer(row, "hlc_counter"),
  });
  try {
    validate(record);
  } catch {
    throw new PlanChangeStoreError("corrupt-record");
  }
  return record;
}

function buildPlanChangeRepository(
  store: SqlStore,
  runTransaction: TransactionRunner,
): PlanChangeRepository {
  const read = async (id: string): Promise<PlanChangeRecord | undefined> => {
    if (!ULID.test(id)) throw new PlanChangeStoreError("invalid-change");
    const row = await store.get(`SELECT ${COLUMNS} FROM plan_change WHERE id=?`, [id]);
    return row === undefined ? undefined : fromRow(row);
  };

  const readPreview = async (planId: string): Promise<PlanChangeRecord | undefined> => {
    if (!ULID.test(planId)) throw new PlanChangeStoreError("invalid-change");
    const rows = await store.all(
      `SELECT ${COLUMNS} FROM plan_change WHERE plan_id=? AND status='preview'
ORDER BY created_at_ms ASC,id ASC`,
      [planId],
    );
    if (rows.length > 1) throw new PlanChangeStoreError("corrupt-record");
    return rows[0] === undefined ? undefined : fromRow(rows[0]);
  };

  const repository: PlanChangeRepository = {
    read,
    readPreview,
    async createPreview(input) {
      const record: PlanChangeRecord = {
        ...input,
        status: "preview",
        version: 1,
        resultRevisionNumber: null,
        updatedAtMs: input.createdAtMs,
        terminalAtMs: null,
      };
      validate(record);
      return runTransaction(async () => {
        const existingById = await read(input.id);
        if (existingById !== undefined) {
          if (
            existingById.status === "preview" &&
            existingById.version === 1 &&
            existingById.planId === input.planId &&
            existingById.baseRevisionNumber === input.baseRevisionNumber &&
            existingById.resultRevisionNumber === null &&
            existingById.diffJson === input.diffJson &&
            existingById.rationale === input.rationale &&
            existingById.premisesJson === input.premisesJson &&
            existingById.previewFingerprint === input.previewFingerprint &&
            existingById.reconciliationEffectJson === input.reconciliationEffectJson &&
            existingById.createdAtMs === input.createdAtMs &&
            existingById.updatedAtMs === input.createdAtMs &&
            existingById.terminalAtMs === null &&
            existingById.deviceId === input.deviceId &&
            existingById.hlcPhysicalMs === input.hlcPhysicalMs &&
            existingById.hlcCounter === input.hlcCounter
          ) {
            return existingById;
          }
          throw new PlanChangeStoreError("change-conflict");
        }
        const existingPreview = await readPreview(input.planId);
        if (existingPreview !== undefined) throw new PlanChangeStoreError("change-conflict");
        const plan = await store.get(
          `SELECT status,current_revision_number,updated_at_ms,hlc_physical_ms,hlc_counter
FROM planning_plan WHERE plan_id=?`,
          [input.planId],
        );
        if (plan === undefined) throw new PlanChangeStoreError("missing-plan");
        if (
          text(plan, "status") !== "active" ||
          integer(plan, "current_revision_number") !== input.baseRevisionNumber ||
          input.createdAtMs < integer(plan, "updated_at_ms") ||
          !clockNotBefore(input, {
            hlcPhysicalMs: integer(plan, "hlc_physical_ms"),
            hlcCounter: integer(plan, "hlc_counter"),
          })
        ) {
          throw new PlanChangeStoreError("stale-change");
        }
        await store.run(
          `INSERT INTO plan_change (${COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            record.id,
            record.planId,
            record.status,
            record.version,
            record.baseRevisionNumber,
            record.resultRevisionNumber,
            record.diffJson,
            record.rationale,
            record.premisesJson,
            record.previewFingerprint,
            record.reconciliationEffectJson,
            record.createdAtMs,
            record.updatedAtMs,
            record.terminalAtMs,
            record.deviceId,
            record.hlcPhysicalMs,
            record.hlcCounter,
          ],
        );
        const created = await read(input.id);
        if (created === undefined) throw new PlanChangeStoreError("change-conflict");
        return created;
      });
    },
    async transition(input) {
      if (
        !ULID.test(input.id) ||
        !Number.isSafeInteger(input.expectedVersion) ||
        input.expectedVersion <= 0 ||
        !["applied", "stale", "discarded"].includes(input.target) ||
        (input.target === "applied") !== (input.resultRevisionNumber !== null) ||
        (input.resultRevisionNumber !== null &&
          (!Number.isSafeInteger(input.resultRevisionNumber) || input.resultRevisionNumber <= 0)) ||
        !Number.isSafeInteger(input.terminalAtMs) ||
        input.terminalAtMs < 0 ||
        !Number.isSafeInteger(input.updatedAtMs) ||
        input.updatedAtMs < input.terminalAtMs ||
        !validClock(input)
      ) {
        throw new PlanChangeStoreError("invalid-change");
      }
      return runTransaction(async () => {
        const current = await read(input.id);
        if (current === undefined) throw new PlanChangeStoreError("missing-change");
        if (
          current.status === input.target &&
          current.resultRevisionNumber === input.resultRevisionNumber &&
          current.version === input.expectedVersion + 1 &&
          current.terminalAtMs === input.terminalAtMs &&
          current.updatedAtMs === input.updatedAtMs &&
          current.deviceId === input.deviceId &&
          current.hlcPhysicalMs === input.hlcPhysicalMs &&
          current.hlcCounter === input.hlcCounter
        ) {
          return current;
        }
        if (
          current.status !== "preview" ||
          current.version !== input.expectedVersion ||
          input.terminalAtMs < current.createdAtMs ||
          input.terminalAtMs < current.updatedAtMs ||
          input.updatedAtMs < current.updatedAtMs ||
          !clockNotBefore(input, current)
        ) {
          throw new PlanChangeStoreError("stale-change");
        }
        if (input.target === "stale") {
          const plan = await store.get(
            "SELECT status,current_revision_number FROM planning_plan WHERE plan_id=?",
            [current.planId],
          );
          if (
            plan !== undefined &&
            text(plan, "status") === "active" &&
            integer(plan, "current_revision_number") === current.baseRevisionNumber
          ) {
            throw new PlanChangeStoreError("stale-change");
          }
        }
        if (input.resultRevisionNumber !== null) {
          if (input.resultRevisionNumber !== current.baseRevisionNumber + 1) {
            throw new PlanChangeStoreError("stale-change");
          }
          const revision = await store.get(
            `SELECT revision.id
FROM plan_revision AS revision
JOIN planning_plan AS aggregate ON aggregate.plan_id=revision.plan_id
WHERE revision.plan_id=? AND revision.revision_number=?
  AND revision.source_kind='plan-change' AND revision.source_id=?
  AND aggregate.status='active' AND aggregate.current_revision_number=?`,
            [current.planId, input.resultRevisionNumber, current.id, input.resultRevisionNumber],
          );
          if (revision === undefined) throw new PlanChangeStoreError("stale-change");
        }
        await store.run(
          `UPDATE plan_change SET status=?,version=version+1,result_revision_number=?,terminal_at_ms=?,
updated_at_ms=?,device_id=?,hlc_physical_ms=?,hlc_counter=?
WHERE id=? AND status='preview' AND version=?`,
          [
            input.target,
            input.resultRevisionNumber,
            input.terminalAtMs,
            input.updatedAtMs,
            input.deviceId,
            input.hlcPhysicalMs,
            input.hlcCounter,
            input.id,
            input.expectedVersion,
          ],
        );
        const terminal = await read(input.id);
        if (terminal === undefined || terminal.status !== input.target) {
          throw new PlanChangeStoreError("stale-change");
        }
        return terminal;
      });
    },
  };
  return Object.freeze(repository);
}

export function createPlanChangeRepository(store: PlanningStore): PlanChangeRepository {
  return buildPlanChangeRepository(store, (operation) => store.transaction(operation));
}

export function createPlanChangeRepositoryInTransaction(store: SqlStore): PlanChangeRepository {
  return buildPlanChangeRepository(store, (operation) => operation());
}
