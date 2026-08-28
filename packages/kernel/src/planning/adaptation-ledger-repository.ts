import type { MigratorStore } from "../store/migrator.js";
import type { Row, SqlStore } from "../store/ports.js";
import { addCivilDays } from "./date-keys.js";
import type { PlanWorkoutOrigin, PlanWorkoutRecord } from "./repository.js";

export type PlanAdaptationKind = "proposal-applied" | "drift-adopted" | "undo";
export type PlanAdaptationOperation = "update" | "add" | "remove";

export interface PlanAdaptationWorkoutSnapshot {
  readonly dateKey: number;
  readonly sport: string;
  readonly name: string;
  readonly durationS: number | null;
  readonly structureJson: string;
  readonly origin: PlanWorkoutOrigin;
}

export interface PlanAdaptationLedgerRecord {
  readonly id: string;
  readonly planId: string;
  readonly targetWorkoutId: string;
  readonly operation: PlanAdaptationOperation;
  readonly kind: PlanAdaptationKind;
  readonly sourceId: string;
  readonly reversalOfId: string | null;
  readonly label: string;
  readonly beforeJson: string | null;
  readonly afterJson: string | null;
  readonly weekLoadBefore: number | null;
  readonly weekLoadAfter: number | null;
  readonly occurredAtMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface PlanAdaptationLedgerRepository {
  append(record: PlanAdaptationLedgerRecord): Promise<PlanAdaptationLedgerRecord>;
  read(id: string): Promise<PlanAdaptationLedgerRecord | undefined>;
  readForPlan(planId: string): Promise<readonly PlanAdaptationLedgerRecord[]>;
  reverse(input: {
    readonly targetId: string;
    readonly expectedPlanUpdatedAtMs: number;
    readonly expectedPlanHlcPhysicalMs: number;
    readonly expectedPlanHlcCounter: number;
    readonly expectedWorkout: PlanWorkoutRecord;
    readonly nextWorkout: PlanWorkoutRecord | null;
    readonly undo: PlanAdaptationLedgerRecord;
    readonly mirrorJob: {
      readonly id: string;
      readonly windowStartDateKey: number;
      readonly windowEndDateKey: number;
      readonly createdAtMs: number;
    };
  }): Promise<PlanAdaptationLedgerRecord>;
}

export class PlanAdaptationLedgerValidationError extends Error {
  readonly code: "invalid-ledger" | "missing-ledger" | "invalid-transition" | "stale-base";

  constructor(code: PlanAdaptationLedgerValidationError["code"]) {
    super(`plan adaptation ledger rejected: ${code}`);
    this.name = "PlanAdaptationLedgerValidationError";
    this.code = code;
  }
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KINDS = new Set<unknown>(["proposal-applied", "drift-adopted", "undo"]);
const OPERATIONS = new Set<unknown>(["update", "add", "remove"]);
const ORIGINS = new Set<unknown>(["coach", "athlete"]);

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validDateKey(value: number): boolean {
  try {
    addCivilDays(value, 0);
    return true;
  } catch {
    return false;
  }
}

export function planAdaptationWorkoutSnapshot(
  workout: PlanWorkoutRecord,
): PlanAdaptationWorkoutSnapshot {
  return Object.freeze({
    dateKey: workout.dateKey,
    sport: workout.sport,
    name: workout.name,
    durationS: workout.durationS,
    structureJson: workout.structureJson,
    origin: workout.origin,
  });
}

export function encodePlanAdaptationWorkoutSnapshot(
  snapshot: PlanAdaptationWorkoutSnapshot,
): string {
  validateSnapshot(snapshot);
  return JSON.stringify({
    dateKey: snapshot.dateKey,
    sport: snapshot.sport,
    name: snapshot.name,
    durationS: snapshot.durationS,
    structureJson: snapshot.structureJson,
    origin: snapshot.origin,
  });
}

export function parsePlanAdaptationWorkoutSnapshot(value: string): PlanAdaptationWorkoutSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new PlanAdaptationLedgerValidationError("invalid-ledger");
  }
  if (!object(parsed) || Object.keys(parsed).length !== 6) {
    throw new PlanAdaptationLedgerValidationError("invalid-ledger");
  }
  const snapshot: PlanAdaptationWorkoutSnapshot = {
    dateKey: Number(parsed.dateKey),
    sport: String(parsed.sport),
    name: String(parsed.name),
    durationS: parsed.durationS === null ? null : Number(parsed.durationS),
    structureJson: String(parsed.structureJson),
    origin: String(parsed.origin) as PlanWorkoutOrigin,
  };
  validateSnapshot(snapshot);
  return Object.freeze(snapshot);
}

function validateSnapshot(snapshot: PlanAdaptationWorkoutSnapshot): void {
  let structureValid = false;
  try {
    JSON.parse(snapshot.structureJson);
    structureValid = true;
  } catch {
    structureValid = false;
  }
  if (
    !Number.isSafeInteger(snapshot.dateKey) ||
    !validDateKey(snapshot.dateKey) ||
    snapshot.sport.length === 0 ||
    snapshot.name.length === 0 ||
    (snapshot.durationS !== null &&
      (!Number.isSafeInteger(snapshot.durationS) || snapshot.durationS <= 0)) ||
    !structureValid ||
    !ORIGINS.has(snapshot.origin)
  ) {
    throw new PlanAdaptationLedgerValidationError("invalid-ledger");
  }
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new PlanAdaptationLedgerValidationError("invalid-ledger");
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new PlanAdaptationLedgerValidationError("invalid-ledger");
  }
  return value;
}

function nullableText(row: Row, key: string): string | null {
  const value = row[key];
  if (value !== null && typeof value !== "string") {
    throw new PlanAdaptationLedgerValidationError("invalid-ledger");
  }
  return value;
}

function validate(record: PlanAdaptationLedgerRecord): void {
  if (
    !ULID.test(record.id) ||
    !ULID.test(record.planId) ||
    !ULID.test(record.targetWorkoutId) ||
    !OPERATIONS.has(record.operation) ||
    !KINDS.has(record.kind) ||
    record.sourceId.length === 0 ||
    (record.kind === "undo") !== (record.reversalOfId !== null) ||
    (record.reversalOfId !== null && !ULID.test(record.reversalOfId)) ||
    record.label.length === 0 ||
    (record.weekLoadBefore === null) !== (record.weekLoadAfter === null) ||
    (record.weekLoadBefore !== null &&
      (!Number.isFinite(record.weekLoadBefore) || record.weekLoadBefore < 0)) ||
    (record.weekLoadAfter !== null &&
      (!Number.isFinite(record.weekLoadAfter) || record.weekLoadAfter < 0)) ||
    !Number.isSafeInteger(record.occurredAtMs) ||
    record.occurredAtMs < 0 ||
    !DEVICE_ID.test(record.deviceId) ||
    !Number.isSafeInteger(record.hlcPhysicalMs) ||
    record.hlcPhysicalMs < 0 ||
    !Number.isSafeInteger(record.hlcCounter) ||
    record.hlcCounter < 0
  ) {
    throw new PlanAdaptationLedgerValidationError("invalid-ledger");
  }
  if (
    (record.operation === "update" && (record.beforeJson === null || record.afterJson === null)) ||
    (record.operation === "add" && (record.beforeJson !== null || record.afterJson === null)) ||
    (record.operation === "remove" && (record.beforeJson === null || record.afterJson !== null))
  ) {
    throw new PlanAdaptationLedgerValidationError("invalid-ledger");
  }
  if (record.beforeJson !== null) parsePlanAdaptationWorkoutSnapshot(record.beforeJson);
  if (record.afterJson !== null) parsePlanAdaptationWorkoutSnapshot(record.afterJson);
}

const COLUMNS = `id, plan_id, target_workout_id, operation, kind, source_id, reversal_of_id, label,
before_json, after_json, week_load_before, week_load_after, occurred_at_ms, device_id,
hlc_physical_ms, hlc_counter`;

function nullableNumber(row: Row, key: string): number | null {
  const value = row[key];
  if (value !== null && typeof value !== "number") {
    throw new PlanAdaptationLedgerValidationError("invalid-ledger");
  }
  return value;
}

function fromRow(row: Row): PlanAdaptationLedgerRecord {
  const record: PlanAdaptationLedgerRecord = {
    id: text(row, "id"),
    planId: text(row, "plan_id"),
    targetWorkoutId: text(row, "target_workout_id"),
    operation: text(row, "operation") as PlanAdaptationOperation,
    kind: text(row, "kind") as PlanAdaptationKind,
    sourceId: text(row, "source_id"),
    reversalOfId: nullableText(row, "reversal_of_id"),
    label: text(row, "label"),
    beforeJson: nullableText(row, "before_json"),
    afterJson: nullableText(row, "after_json"),
    weekLoadBefore: nullableNumber(row, "week_load_before"),
    weekLoadAfter: nullableNumber(row, "week_load_after"),
    occurredAtMs: integer(row, "occurred_at_ms"),
    deviceId: text(row, "device_id"),
    hlcPhysicalMs: integer(row, "hlc_physical_ms"),
    hlcCounter: integer(row, "hlc_counter"),
  };
  validate(record);
  return Object.freeze(record);
}

export async function insertPlanAdaptationLedgerRecord(
  store: SqlStore,
  record: PlanAdaptationLedgerRecord,
): Promise<void> {
  validate(record);
  await store.run(
    `INSERT INTO plan_adaptation_ledger (${COLUMNS})
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.id,
      record.planId,
      record.targetWorkoutId,
      record.operation,
      record.kind,
      record.sourceId,
      record.reversalOfId,
      record.label,
      record.beforeJson,
      record.afterJson,
      record.weekLoadBefore,
      record.weekLoadAfter,
      record.occurredAtMs,
      record.deviceId,
      record.hlcPhysicalMs,
      record.hlcCounter,
    ],
  );
}

function workoutMatchesRow(row: Row, workout: PlanWorkoutRecord): boolean {
  const duration = row.duration_s;
  return (
    text(row, "id") === workout.id &&
    text(row, "plan_id") === workout.planId &&
    integer(row, "date_key") === workout.dateKey &&
    text(row, "sport") === workout.sport &&
    text(row, "name") === workout.name &&
    (duration === null || typeof duration === "number") &&
    duration === workout.durationS &&
    text(row, "structure_json") === workout.structureJson &&
    text(row, "origin") === workout.origin &&
    text(row, "device_id") === workout.deviceId &&
    integer(row, "hlc_physical_ms") === workout.hlcPhysicalMs &&
    integer(row, "hlc_counter") === workout.hlcCounter
  );
}

type AdaptationStore = SqlStore & Pick<MigratorStore, "transaction">;

export function createPlanAdaptationLedgerRepository(
  store: AdaptationStore,
): PlanAdaptationLedgerRepository {
  const read = async (id: string): Promise<PlanAdaptationLedgerRecord | undefined> => {
    if (!ULID.test(id)) throw new PlanAdaptationLedgerValidationError("invalid-ledger");
    const row = await store.get(`SELECT ${COLUMNS} FROM plan_adaptation_ledger WHERE id=?`, [id]);
    return row === undefined ? undefined : fromRow(row);
  };
  return Object.freeze({
    async append(record: PlanAdaptationLedgerRecord) {
      await insertPlanAdaptationLedgerRecord(store, record);
      const stored = await read(record.id);
      if (stored === undefined) throw new PlanAdaptationLedgerValidationError("missing-ledger");
      return stored;
    },
    read,
    async readForPlan(planId: string) {
      if (!ULID.test(planId)) throw new PlanAdaptationLedgerValidationError("invalid-ledger");
      return (
        await store.all(
          `SELECT ${COLUMNS} FROM plan_adaptation_ledger
WHERE plan_id=? ORDER BY occurred_at_ms DESC,id DESC`,
          [planId],
        )
      ).map(fromRow);
    },
    async reverse(input: Parameters<PlanAdaptationLedgerRepository["reverse"]>[0]) {
      validate(input.undo);
      if (
        !ULID.test(input.targetId) ||
        input.undo.kind !== "undo" ||
        input.undo.reversalOfId !== input.targetId ||
        input.undo.planId !== input.expectedWorkout.planId ||
        input.undo.targetWorkoutId !== input.expectedWorkout.id ||
        !Number.isSafeInteger(input.expectedPlanUpdatedAtMs) ||
        !Number.isSafeInteger(input.expectedPlanHlcPhysicalMs) ||
        !Number.isSafeInteger(input.expectedPlanHlcCounter) ||
        !ULID.test(input.mirrorJob.id) ||
        input.mirrorJob.windowEndDateKey < input.mirrorJob.windowStartDateKey
      ) {
        throw new PlanAdaptationLedgerValidationError("invalid-ledger");
      }
      return store.transaction(async () => {
        const latestRow = await store.get(
          `SELECT ${COLUMNS} FROM plan_adaptation_ledger
WHERE plan_id=? ORDER BY occurred_at_ms DESC,id DESC LIMIT 1`,
          [input.undo.planId],
        );
        if (latestRow === undefined)
          throw new PlanAdaptationLedgerValidationError("missing-ledger");
        const latest = fromRow(latestRow);
        if (latest.id !== input.targetId || latest.kind === "undo") {
          throw new PlanAdaptationLedgerValidationError("stale-base");
        }
        const planRow = await store.get(
          `SELECT status, updated_at_ms, hlc_physical_ms, hlc_counter FROM plan WHERE id=?`,
          [input.undo.planId],
        );
        if (
          planRow === undefined ||
          text(planRow, "status") !== "active" ||
          integer(planRow, "updated_at_ms") !== input.expectedPlanUpdatedAtMs ||
          integer(planRow, "hlc_physical_ms") !== input.expectedPlanHlcPhysicalMs ||
          integer(planRow, "hlc_counter") !== input.expectedPlanHlcCounter
        ) {
          throw new PlanAdaptationLedgerValidationError("stale-base");
        }
        const workoutRow = await store.get(
          `SELECT id, plan_id, date_key, sport, name, duration_s, structure_json, origin,
device_id, hlc_physical_ms, hlc_counter FROM plan_workout WHERE id=? AND plan_id=?`,
          [input.expectedWorkout.id, input.expectedWorkout.planId],
        );
        if (
          workoutRow === undefined ||
          !workoutMatchesRow(workoutRow, input.expectedWorkout) ||
          encodePlanAdaptationWorkoutSnapshot(
            planAdaptationWorkoutSnapshot(input.expectedWorkout),
          ) !== latest.afterJson ||
          (latest.operation === "update" &&
            (input.nextWorkout === null ||
              input.undo.operation !== "update" ||
              encodePlanAdaptationWorkoutSnapshot(
                planAdaptationWorkoutSnapshot(input.nextWorkout),
              ) !== latest.beforeJson)) ||
          (latest.operation === "add" &&
            (input.nextWorkout !== null || input.undo.operation !== "remove")) ||
          (latest.operation !== "update" && latest.operation !== "add") ||
          input.undo.beforeJson !== latest.afterJson ||
          input.undo.afterJson !== latest.beforeJson ||
          input.undo.weekLoadBefore !== latest.weekLoadAfter ||
          input.undo.weekLoadAfter !== latest.weekLoadBefore
        ) {
          throw new PlanAdaptationLedgerValidationError("stale-base");
        }
        if (input.nextWorkout === null) {
          await store.run("DELETE FROM plan_workout WHERE id=? AND plan_id=?", [
            input.expectedWorkout.id,
            input.expectedWorkout.planId,
          ]);
        } else {
          await store.run(
            `UPDATE plan_workout SET date_key=?, sport=?, name=?, duration_s=?, structure_json=?,
origin=?, device_id=?, hlc_physical_ms=?, hlc_counter=? WHERE id=? AND plan_id=?`,
            [
              input.nextWorkout.dateKey,
              input.nextWorkout.sport,
              input.nextWorkout.name,
              input.nextWorkout.durationS,
              input.nextWorkout.structureJson,
              input.nextWorkout.origin,
              input.nextWorkout.deviceId,
              input.nextWorkout.hlcPhysicalMs,
              input.nextWorkout.hlcCounter,
              input.nextWorkout.id,
              input.nextWorkout.planId,
            ],
          );
        }
        await store.run(
          `UPDATE plan SET updated_at_ms=?, device_id=?, hlc_physical_ms=?, hlc_counter=? WHERE id=?`,
          [
            input.undo.occurredAtMs,
            input.undo.deviceId,
            input.undo.hlcPhysicalMs,
            input.undo.hlcCounter,
            input.undo.planId,
          ],
        );
        await insertPlanAdaptationLedgerRecord(store, input.undo);
        await store.run(
          `INSERT INTO plan_reconciliation_job (
  id, plan_id, kind, status, window_start_date_key, window_end_date_key,
  attempt_count, failure_count, resumed_count, last_resumed_attempt, last_error_code,
  created_at_ms, updated_at_ms, completed_at_ms
) VALUES (?, ?, 'mirror', 'pending', ?, ?, 0, 0, 0, NULL, NULL, ?, ?, NULL)
ON CONFLICT(plan_id, kind, window_start_date_key, window_end_date_key) DO UPDATE SET
  status='pending', attempt_count=0, failure_count=0, resumed_count=0,
  last_resumed_attempt=NULL, last_error_code=NULL, updated_at_ms=excluded.updated_at_ms,
  completed_at_ms=NULL`,
          [
            input.mirrorJob.id,
            input.undo.planId,
            input.mirrorJob.windowStartDateKey,
            input.mirrorJob.windowEndDateKey,
            input.mirrorJob.createdAtMs,
            input.mirrorJob.createdAtMs,
          ],
        );
        const stored = await read(input.undo.id);
        if (stored === undefined) throw new PlanAdaptationLedgerValidationError("missing-ledger");
        return stored;
      });
    },
  });
}
