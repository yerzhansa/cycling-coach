import type { MigratorStore } from "../store/migrator.js";
import type { Row, SqlStore } from "../store/ports.js";

export type PlanLifecycleStatus = "active" | "closed";
export type PlanCloseReason = "completed" | "stopped";
export type StoredPlanCloseReason = PlanCloseReason | "legacy-unclassified";
export type PlanRevisionSource = "activation" | "plan-change" | "migration";
export const PLAN_COMPLETION_ACTOR = "system:plan-completion" as const;

export interface PlanAggregateRecord {
  readonly planId: string;
  readonly status: PlanLifecycleStatus;
  readonly version: number;
  readonly currentRevisionNumber: number;
  readonly activatedAtMs: number;
  readonly closedAtMs: number | null;
  readonly closeReason: StoredPlanCloseReason | null;
  readonly closeActor: string | null;
  readonly updatedAtMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface PlanRevisionRecord {
  readonly id: string;
  readonly planId: string;
  readonly revisionNumber: number;
  readonly parentRevisionNumber: number | null;
  readonly sourceKind: PlanRevisionSource;
  readonly sourceId: string | null;
  readonly snapshotJson: string;
  readonly fingerprint: string;
  readonly createdAtMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface RegisterPlanAggregateInput {
  readonly planId: string;
  readonly status: PlanLifecycleStatus;
  readonly activatedAtMs: number;
  readonly closedAtMs: number | null;
  readonly closeReason: StoredPlanCloseReason | null;
  readonly closeActor: string | null;
  readonly updatedAtMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
  readonly initialRevision: PlanRevisionRecord;
}

export interface AppendPlanRevisionInput {
  readonly planId: string;
  readonly expectedVersion: number;
  readonly expectedRevisionNumber: number;
  readonly updatedAtMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
  readonly revision: PlanRevisionRecord;
}

export interface ClosePlanAggregateInput {
  readonly planId: string;
  readonly expectedVersion: number;
  readonly reason: PlanCloseReason;
  readonly actor: string;
  readonly closedAtMs: number;
  readonly updatedAtMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface PlanAggregateRepository {
  register(input: RegisterPlanAggregateInput): Promise<PlanAggregateRecord>;
  read(planId: string): Promise<PlanAggregateRecord | undefined>;
  readActive(): Promise<PlanAggregateRecord | undefined>;
  readRevision(planId: string, revisionNumber: number): Promise<PlanRevisionRecord | undefined>;
  readRevisions(planId: string): Promise<readonly PlanRevisionRecord[]>;
  appendRevision(input: AppendPlanRevisionInput): Promise<PlanAggregateRecord>;
  close(input: ClosePlanAggregateInput): Promise<PlanAggregateRecord>;
}

export type PlanAggregateStoreErrorCode =
  | "invalid-plan"
  | "missing-plan"
  | "missing-legacy-plan"
  | "active-plan-exists"
  | "plan-conflict"
  | "stale-plan"
  | "plan-not-active"
  | "corrupt-record";

export class PlanAggregateStoreError extends Error {
  readonly code: PlanAggregateStoreErrorCode;

  constructor(code: PlanAggregateStoreErrorCode) {
    super(`Plan aggregate rejected: ${code}`);
    this.name = "PlanAggregateStoreError";
    this.code = code;
  }
}

type PlanningStore = SqlStore & Pick<MigratorStore, "transaction">;
type TransactionRunner = <T>(operation: () => Promise<T>) => Promise<T>;

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/u;
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const STATUSES = new Set<unknown>(["active", "closed"]);
const CLOSE_REASONS = new Set<unknown>(["completed", "stopped", "legacy-unclassified"]);
const REVISION_SOURCES = new Set<unknown>(["activation", "plan-change", "migration"]);
const PLAN_COLUMNS = `plan_id,status,version,current_revision_number,activated_at_ms,closed_at_ms,
close_reason,close_actor,updated_at_ms,device_id,hlc_physical_ms,hlc_counter`;
const REVISION_COLUMNS = `id,plan_id,revision_number,parent_revision_number,source_kind,source_id,
snapshot_json,fingerprint,created_at_ms,device_id,hlc_physical_ms,hlc_counter`;

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
  if (typeof value !== "string") throw new PlanAggregateStoreError("corrupt-record");
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new PlanAggregateStoreError("corrupt-record");
  }
  return value;
}

function nullableText(row: Row, key: string): string | null {
  const value = row[key];
  if (value !== null && typeof value !== "string") {
    throw new PlanAggregateStoreError("corrupt-record");
  }
  return value;
}

function nullableInteger(row: Row, key: string): number | null {
  const value = row[key];
  if (value !== null && (typeof value !== "number" || !Number.isSafeInteger(value))) {
    throw new PlanAggregateStoreError("corrupt-record");
  }
  return value;
}

function validateAggregate(record: PlanAggregateRecord): void {
  const closed = record.status === "closed";
  const validClosure = closed
    ? record.closedAtMs !== null &&
      (record.closeReason === "legacy-unclassified"
        ? record.closeActor === null
        : record.closeReason === "completed"
          ? record.closeActor === PLAN_COMPLETION_ACTOR
          : record.closeReason === "stopped" && record.closeActor !== null)
    : record.closedAtMs === null && record.closeReason === null && record.closeActor === null;
  if (
    !ULID.test(record.planId) ||
    !STATUSES.has(record.status) ||
    !Number.isSafeInteger(record.version) ||
    record.version <= 0 ||
    !Number.isSafeInteger(record.currentRevisionNumber) ||
    record.currentRevisionNumber <= 0 ||
    !Number.isSafeInteger(record.activatedAtMs) ||
    record.activatedAtMs < 0 ||
    !Number.isSafeInteger(record.updatedAtMs) ||
    record.updatedAtMs < record.activatedAtMs ||
    !validClock(record) ||
    !validClosure ||
    (record.closedAtMs !== null &&
      (!Number.isSafeInteger(record.closedAtMs) ||
        record.closedAtMs < record.activatedAtMs ||
        record.closedAtMs > record.updatedAtMs)) ||
    (record.closeReason !== null && !CLOSE_REASONS.has(record.closeReason)) ||
    (record.closeActor !== null && (record.closeActor.length < 1 || record.closeActor.length > 128))
  ) {
    throw new PlanAggregateStoreError("invalid-plan");
  }
}

function validateRevision(record: PlanRevisionRecord): void {
  const validSource =
    (record.sourceKind === "migration" && record.revisionNumber === 1) ||
    (record.sourceKind === "activation" &&
      record.revisionNumber === 1 &&
      record.sourceId !== null &&
      ULID.test(record.sourceId)) ||
    (record.sourceKind === "plan-change" &&
      record.revisionNumber > 1 &&
      record.sourceId !== null &&
      ULID.test(record.sourceId));
  if (
    !ULID.test(record.id) ||
    !ULID.test(record.planId) ||
    !Number.isSafeInteger(record.revisionNumber) ||
    record.revisionNumber <= 0 ||
    (record.revisionNumber === 1
      ? record.parentRevisionNumber !== null
      : record.parentRevisionNumber !== record.revisionNumber - 1) ||
    !REVISION_SOURCES.has(record.sourceKind) ||
    !validSource ||
    (record.sourceId !== null && (record.sourceId.length < 1 || record.sourceId.length > 512)) ||
    !validJson(record.snapshotJson) ||
    !SHA256.test(record.fingerprint) ||
    !Number.isSafeInteger(record.createdAtMs) ||
    record.createdAtMs < 0 ||
    !validClock(record)
  ) {
    throw new PlanAggregateStoreError("invalid-plan");
  }
}

function aggregateFromRow(row: Row): PlanAggregateRecord {
  const record: PlanAggregateRecord = Object.freeze({
    planId: text(row, "plan_id"),
    status: text(row, "status") as PlanLifecycleStatus,
    version: integer(row, "version"),
    currentRevisionNumber: integer(row, "current_revision_number"),
    activatedAtMs: integer(row, "activated_at_ms"),
    closedAtMs: nullableInteger(row, "closed_at_ms"),
    closeReason: nullableText(row, "close_reason") as StoredPlanCloseReason | null,
    closeActor: nullableText(row, "close_actor"),
    updatedAtMs: integer(row, "updated_at_ms"),
    deviceId: text(row, "device_id"),
    hlcPhysicalMs: integer(row, "hlc_physical_ms"),
    hlcCounter: integer(row, "hlc_counter"),
  });
  try {
    validateAggregate(record);
  } catch {
    throw new PlanAggregateStoreError("corrupt-record");
  }
  return record;
}

function revisionFromRow(row: Row): PlanRevisionRecord {
  const record: PlanRevisionRecord = Object.freeze({
    id: text(row, "id"),
    planId: text(row, "plan_id"),
    revisionNumber: integer(row, "revision_number"),
    parentRevisionNumber: nullableInteger(row, "parent_revision_number"),
    sourceKind: text(row, "source_kind") as PlanRevisionSource,
    sourceId: nullableText(row, "source_id"),
    snapshotJson: text(row, "snapshot_json"),
    fingerprint: text(row, "fingerprint"),
    createdAtMs: integer(row, "created_at_ms"),
    deviceId: text(row, "device_id"),
    hlcPhysicalMs: integer(row, "hlc_physical_ms"),
    hlcCounter: integer(row, "hlc_counter"),
  });
  try {
    validateRevision(record);
  } catch {
    throw new PlanAggregateStoreError("corrupt-record");
  }
  return record;
}

function sameRegistration(
  aggregate: PlanAggregateRecord,
  revision: PlanRevisionRecord | undefined,
  input: RegisterPlanAggregateInput,
): boolean {
  return (
    revision !== undefined &&
    aggregate.version === 1 &&
    aggregate.status === input.status &&
    aggregate.activatedAtMs === input.activatedAtMs &&
    aggregate.closedAtMs === input.closedAtMs &&
    aggregate.closeReason === input.closeReason &&
    aggregate.closeActor === input.closeActor &&
    aggregate.updatedAtMs === input.updatedAtMs &&
    aggregate.deviceId === input.deviceId &&
    aggregate.hlcPhysicalMs === input.hlcPhysicalMs &&
    aggregate.hlcCounter === input.hlcCounter &&
    aggregate.currentRevisionNumber === 1 &&
    revision.id === input.initialRevision.id &&
    revision.planId === input.initialRevision.planId &&
    revision.revisionNumber === input.initialRevision.revisionNumber &&
    revision.parentRevisionNumber === input.initialRevision.parentRevisionNumber &&
    revision.sourceKind === input.initialRevision.sourceKind &&
    revision.sourceId === input.initialRevision.sourceId &&
    revision.fingerprint === input.initialRevision.fingerprint &&
    revision.snapshotJson === input.initialRevision.snapshotJson &&
    revision.createdAtMs === input.initialRevision.createdAtMs &&
    revision.deviceId === input.initialRevision.deviceId &&
    revision.hlcPhysicalMs === input.initialRevision.hlcPhysicalMs &&
    revision.hlcCounter === input.initialRevision.hlcCounter
  );
}

function buildPlanAggregateRepository(
  store: SqlStore,
  runTransaction: TransactionRunner,
): PlanAggregateRepository {
  const read = async (planId: string): Promise<PlanAggregateRecord | undefined> => {
    if (!ULID.test(planId)) throw new PlanAggregateStoreError("invalid-plan");
    const row = await store.get(`SELECT ${PLAN_COLUMNS} FROM planning_plan WHERE plan_id=?`, [
      planId,
    ]);
    return row === undefined ? undefined : aggregateFromRow(row);
  };

  const readRevision = async (
    planId: string,
    revisionNumber: number,
  ): Promise<PlanRevisionRecord | undefined> => {
    if (!ULID.test(planId) || !Number.isSafeInteger(revisionNumber) || revisionNumber <= 0) {
      throw new PlanAggregateStoreError("invalid-plan");
    }
    const row = await store.get(
      `SELECT ${REVISION_COLUMNS} FROM plan_revision WHERE plan_id=? AND revision_number=?`,
      [planId, revisionNumber],
    );
    return row === undefined ? undefined : revisionFromRow(row);
  };

  const repository: PlanAggregateRepository = {
    read,
    readRevision,
    async readActive() {
      const rows = await store.all(
        `SELECT ${PLAN_COLUMNS} FROM planning_plan WHERE status='active' ORDER BY plan_id ASC`,
      );
      if (rows.length > 1) throw new PlanAggregateStoreError("corrupt-record");
      return rows[0] === undefined ? undefined : aggregateFromRow(rows[0]);
    },
    async readRevisions(planId) {
      if (!ULID.test(planId)) throw new PlanAggregateStoreError("invalid-plan");
      const rows = await store.all(
        `SELECT ${REVISION_COLUMNS} FROM plan_revision WHERE plan_id=? ORDER BY revision_number ASC,id ASC`,
        [planId],
      );
      return Object.freeze(rows.map(revisionFromRow));
    },
    async register(input) {
      const proposed: PlanAggregateRecord = {
        planId: input.planId,
        status: input.status,
        version: 1,
        currentRevisionNumber: 1,
        activatedAtMs: input.activatedAtMs,
        closedAtMs: input.closedAtMs,
        closeReason: input.closeReason,
        closeActor: input.closeActor,
        updatedAtMs: input.updatedAtMs,
        deviceId: input.deviceId,
        hlcPhysicalMs: input.hlcPhysicalMs,
        hlcCounter: input.hlcCounter,
      };
      validateAggregate(proposed);
      validateRevision(input.initialRevision);
      if (
        input.initialRevision.planId !== input.planId ||
        input.initialRevision.revisionNumber !== 1 ||
        input.initialRevision.createdAtMs < input.activatedAtMs ||
        input.initialRevision.createdAtMs > input.updatedAtMs ||
        !clockNotBefore(input, input.initialRevision)
      ) {
        throw new PlanAggregateStoreError("invalid-plan");
      }
      return runTransaction(async () => {
        const existing = await read(input.planId);
        if (existing !== undefined) {
          const revision = await readRevision(input.planId, 1);
          if (sameRegistration(existing, revision, input)) return existing;
          throw new PlanAggregateStoreError("plan-conflict");
        }
        if ((await store.get("SELECT id FROM plan WHERE id=?", [input.planId])) === undefined) {
          throw new PlanAggregateStoreError("missing-legacy-plan");
        }
        if (input.initialRevision.sourceKind === "activation") {
          const creation = await store.get(
            `SELECT creation.status,
draft.output_snapshot_json,draft.activation_fingerprint,draft.created_at_ms,
draft.hlc_physical_ms,draft.hlc_counter
FROM plan_creation AS creation
JOIN plan_creation_draft_revision AS draft
  ON draft.creation_id=creation.id
  AND draft.revision_number=creation.current_draft_revision_number
WHERE creation.id=?`,
            [input.initialRevision.sourceId],
          );
          if (
            creation === undefined ||
            text(creation, "status") !== "review" ||
            input.initialRevision.snapshotJson !== text(creation, "output_snapshot_json") ||
            input.initialRevision.fingerprint !== text(creation, "activation_fingerprint") ||
            input.activatedAtMs < integer(creation, "created_at_ms") ||
            input.initialRevision.createdAtMs < integer(creation, "created_at_ms") ||
            !clockNotBefore(input, {
              hlcPhysicalMs: integer(creation, "hlc_physical_ms"),
              hlcCounter: integer(creation, "hlc_counter"),
            }) ||
            !clockNotBefore(input.initialRevision, {
              hlcPhysicalMs: integer(creation, "hlc_physical_ms"),
              hlcCounter: integer(creation, "hlc_counter"),
            })
          ) {
            throw new PlanAggregateStoreError("invalid-plan");
          }
        }
        if (input.status === "active") {
          const active = await store.get(
            "SELECT plan_id FROM planning_plan WHERE status='active' LIMIT 1",
          );
          if (active !== undefined) throw new PlanAggregateStoreError("active-plan-exists");
        }
        await store.run(
          `INSERT INTO planning_plan (${PLAN_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            input.planId,
            input.status,
            1,
            1,
            input.activatedAtMs,
            input.closedAtMs,
            input.closeReason,
            input.closeActor,
            input.updatedAtMs,
            input.deviceId,
            input.hlcPhysicalMs,
            input.hlcCounter,
          ],
        );
        const revision = input.initialRevision;
        await store.run(
          `INSERT INTO plan_revision (${REVISION_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            revision.id,
            revision.planId,
            revision.revisionNumber,
            revision.parentRevisionNumber,
            revision.sourceKind,
            revision.sourceId,
            revision.snapshotJson,
            revision.fingerprint,
            revision.createdAtMs,
            revision.deviceId,
            revision.hlcPhysicalMs,
            revision.hlcCounter,
          ],
        );
        const created = await read(input.planId);
        if (created === undefined) throw new PlanAggregateStoreError("stale-plan");
        return created;
      });
    },
    async appendRevision(input) {
      validateRevision(input.revision);
      if (
        input.revision.planId !== input.planId ||
        input.revision.revisionNumber !== input.expectedRevisionNumber + 1 ||
        input.revision.parentRevisionNumber !== input.expectedRevisionNumber ||
        !Number.isSafeInteger(input.expectedVersion) ||
        input.expectedVersion <= 0 ||
        !Number.isSafeInteger(input.updatedAtMs) ||
        !validClock(input)
      ) {
        throw new PlanAggregateStoreError("invalid-plan");
      }
      return runTransaction(async () => {
        const current = await read(input.planId);
        if (current === undefined) throw new PlanAggregateStoreError("missing-plan");
        if (
          current.status !== "active" ||
          current.version !== input.expectedVersion ||
          current.currentRevisionNumber !== input.expectedRevisionNumber ||
          input.updatedAtMs < current.updatedAtMs ||
          input.revision.createdAtMs < current.updatedAtMs ||
          input.updatedAtMs < input.revision.createdAtMs ||
          !clockNotBefore(input, current) ||
          !clockNotBefore(input.revision, current) ||
          !clockNotBefore(input, input.revision)
        ) {
          throw new PlanAggregateStoreError("stale-plan");
        }
        const preview = await store.get(
          `SELECT id,base_revision_number,updated_at_ms,hlc_physical_ms,hlc_counter
FROM plan_change WHERE plan_id=? AND status='preview'`,
          [input.planId],
        );
        if (
          preview === undefined ||
          text(preview, "id") !== input.revision.sourceId ||
          integer(preview, "base_revision_number") !== input.expectedRevisionNumber ||
          input.updatedAtMs < integer(preview, "updated_at_ms") ||
          input.revision.createdAtMs < integer(preview, "updated_at_ms") ||
          !clockNotBefore(input, {
            hlcPhysicalMs: integer(preview, "hlc_physical_ms"),
            hlcCounter: integer(preview, "hlc_counter"),
          }) ||
          !clockNotBefore(input.revision, {
            hlcPhysicalMs: integer(preview, "hlc_physical_ms"),
            hlcCounter: integer(preview, "hlc_counter"),
          })
        ) {
          throw new PlanAggregateStoreError("stale-plan");
        }
        await store.run(
          `INSERT INTO plan_revision (${REVISION_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            input.revision.id,
            input.planId,
            input.revision.revisionNumber,
            input.revision.parentRevisionNumber,
            input.revision.sourceKind,
            input.revision.sourceId,
            input.revision.snapshotJson,
            input.revision.fingerprint,
            input.revision.createdAtMs,
            input.revision.deviceId,
            input.revision.hlcPhysicalMs,
            input.revision.hlcCounter,
          ],
        );
        await store.run(
          `UPDATE planning_plan SET version=version+1,current_revision_number=?,updated_at_ms=?,
device_id=?,hlc_physical_ms=?,hlc_counter=?
WHERE plan_id=? AND status='active' AND version=? AND current_revision_number=?`,
          [
            input.revision.revisionNumber,
            input.updatedAtMs,
            input.deviceId,
            input.hlcPhysicalMs,
            input.hlcCounter,
            input.planId,
            input.expectedVersion,
            input.expectedRevisionNumber,
          ],
        );
        const updated = await read(input.planId);
        if (
          updated === undefined ||
          updated.version !== input.expectedVersion + 1 ||
          updated.currentRevisionNumber !== input.expectedRevisionNumber + 1
        ) {
          throw new PlanAggregateStoreError("stale-plan");
        }
        const applied = await store.get(
          "SELECT status,result_revision_number FROM plan_change WHERE id=?",
          [input.revision.sourceId],
        );
        if (
          applied === undefined ||
          text(applied, "status") !== "applied" ||
          integer(applied, "result_revision_number") !== input.revision.revisionNumber
        ) {
          throw new PlanAggregateStoreError("stale-plan");
        }
        return updated;
      });
    },
    async close(input) {
      if (
        !ULID.test(input.planId) ||
        !Number.isSafeInteger(input.expectedVersion) ||
        input.expectedVersion <= 0 ||
        !["completed", "stopped"].includes(input.reason) ||
        input.actor.length < 1 ||
        input.actor.length > 128 ||
        (input.reason === "completed" && input.actor !== PLAN_COMPLETION_ACTOR) ||
        !Number.isSafeInteger(input.closedAtMs) ||
        input.closedAtMs < 0 ||
        !Number.isSafeInteger(input.updatedAtMs) ||
        input.updatedAtMs < input.closedAtMs ||
        !validClock(input)
      ) {
        throw new PlanAggregateStoreError("invalid-plan");
      }
      return runTransaction(async () => {
        const current = await read(input.planId);
        if (current === undefined) throw new PlanAggregateStoreError("missing-plan");
        if (current.status !== "active") throw new PlanAggregateStoreError("plan-not-active");
        const preview = await store.get(
          `SELECT id,updated_at_ms,hlc_physical_ms,hlc_counter
FROM plan_change WHERE plan_id=? AND status='preview'`,
          [input.planId],
        );
        if (
          current.version !== input.expectedVersion ||
          input.closedAtMs < current.activatedAtMs ||
          input.closedAtMs < current.updatedAtMs ||
          input.updatedAtMs < current.updatedAtMs ||
          !clockNotBefore(input, current) ||
          (preview !== undefined &&
            (input.closedAtMs < integer(preview, "updated_at_ms") ||
              input.updatedAtMs < integer(preview, "updated_at_ms") ||
              !clockNotBefore(input, {
                hlcPhysicalMs: integer(preview, "hlc_physical_ms"),
                hlcCounter: integer(preview, "hlc_counter"),
              })))
        ) {
          throw new PlanAggregateStoreError("stale-plan");
        }
        await store.run(
          `UPDATE planning_plan SET status='closed',version=version+1,closed_at_ms=?,close_reason=?,
close_actor=?,updated_at_ms=?,device_id=?,hlc_physical_ms=?,hlc_counter=?
WHERE plan_id=? AND status='active' AND version=?`,
          [
            input.closedAtMs,
            input.reason,
            input.actor,
            input.updatedAtMs,
            input.deviceId,
            input.hlcPhysicalMs,
            input.hlcCounter,
            input.planId,
            input.expectedVersion,
          ],
        );
        const closed = await read(input.planId);
        if (closed === undefined || closed.status !== "closed") {
          throw new PlanAggregateStoreError("stale-plan");
        }
        if (preview !== undefined) {
          const stale = await store.get("SELECT status FROM plan_change WHERE id=?", [
            text(preview, "id"),
          ]);
          if (stale === undefined || text(stale, "status") !== "stale") {
            throw new PlanAggregateStoreError("stale-plan");
          }
        }
        return closed;
      });
    },
  };
  return Object.freeze(repository);
}

export function createPlanAggregateRepository(store: PlanningStore): PlanAggregateRepository {
  return buildPlanAggregateRepository(store, (operation) => store.transaction(operation));
}

export function createPlanAggregateRepositoryInTransaction(
  store: SqlStore,
): PlanAggregateRepository {
  return buildPlanAggregateRepository(store, (operation) => operation());
}
