import type { MigratorStore } from "../store/migrator.js";
import type { Row, SqlStore } from "../store/ports.js";
import type { PlanWorkoutRecord } from "./repository.js";

export type PlanWorkoutDriftStatus = "detected" | "adopted" | "restored";

export interface PlanWorkoutDriftRecord {
  readonly id: string;
  readonly planId: string;
  readonly planWorkoutId: string;
  readonly providerEventId: number;
  readonly providerRevision: string;
  readonly status: PlanWorkoutDriftStatus;
  readonly planSnapshotJson: string;
  readonly providerSnapshotJson: string;
  readonly detectedAtMs: number;
  readonly observedAtMs: number;
  readonly resolvedAtMs: number | null;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface PlanWorkoutDriftRepository {
  observe(record: PlanWorkoutDriftRecord): Promise<PlanWorkoutDriftRecord>;
  read(id: string): Promise<PlanWorkoutDriftRecord | undefined>;
  readOpenForPlan(planId: string): Promise<readonly PlanWorkoutDriftRecord[]>;
  readOpenForWorkout(planWorkoutId: string): Promise<PlanWorkoutDriftRecord | undefined>;
  resolve(input: {
    readonly id: string;
    readonly status: Exclude<PlanWorkoutDriftStatus, "detected">;
    readonly resolvedAtMs: number;
    readonly deviceId: string;
    readonly hlcPhysicalMs: number;
    readonly hlcCounter: number;
  }): Promise<PlanWorkoutDriftRecord>;
  adopt(input: {
    readonly id: string;
    readonly workout: PlanWorkoutRecord;
    readonly resolvedAtMs: number;
    readonly deviceId: string;
    readonly hlcPhysicalMs: number;
    readonly hlcCounter: number;
  }): Promise<PlanWorkoutDriftRecord>;
}

export class PlanWorkoutDriftValidationError extends Error {
  readonly code: "invalid-drift" | "missing-drift" | "invalid-transition";

  constructor(code: PlanWorkoutDriftValidationError["code"]) {
    super(`plan workout drift rejected: ${code}`);
    this.name = "PlanWorkoutDriftValidationError";
    this.code = code;
  }
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STATUS = new Set<unknown>(["detected", "adopted", "restored"]);

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new PlanWorkoutDriftValidationError("invalid-drift");
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new PlanWorkoutDriftValidationError("invalid-drift");
  }
  return value;
}

function nullableInteger(row: Row, key: string): number | null {
  const value = row[key];
  if (value !== null && (typeof value !== "number" || !Number.isSafeInteger(value))) {
    throw new PlanWorkoutDriftValidationError("invalid-drift");
  }
  return value;
}

function validJson(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function validate(record: PlanWorkoutDriftRecord): void {
  const resolved = record.status !== "detected";
  if (
    !ULID.test(record.id) ||
    !ULID.test(record.planId) ||
    !ULID.test(record.planWorkoutId) ||
    !Number.isSafeInteger(record.providerEventId) ||
    record.providerEventId <= 0 ||
    record.providerRevision.length === 0 ||
    !STATUS.has(record.status) ||
    !validJson(record.planSnapshotJson) ||
    !validJson(record.providerSnapshotJson) ||
    !Number.isSafeInteger(record.detectedAtMs) ||
    record.detectedAtMs < 0 ||
    !Number.isSafeInteger(record.observedAtMs) ||
    record.observedAtMs < record.detectedAtMs ||
    (record.resolvedAtMs !== null &&
      (!Number.isSafeInteger(record.resolvedAtMs) || record.resolvedAtMs < record.detectedAtMs)) ||
    resolved !== (record.resolvedAtMs !== null) ||
    !DEVICE_ID.test(record.deviceId) ||
    !Number.isSafeInteger(record.hlcPhysicalMs) ||
    record.hlcPhysicalMs < 0 ||
    !Number.isSafeInteger(record.hlcCounter) ||
    record.hlcCounter < 0
  ) {
    throw new PlanWorkoutDriftValidationError("invalid-drift");
  }
}

function fromRow(row: Row): PlanWorkoutDriftRecord {
  const record: PlanWorkoutDriftRecord = {
    id: text(row, "id"),
    planId: text(row, "plan_id"),
    planWorkoutId: text(row, "plan_workout_id"),
    providerEventId: integer(row, "provider_event_id"),
    providerRevision: text(row, "provider_revision"),
    status: text(row, "status") as PlanWorkoutDriftStatus,
    planSnapshotJson: text(row, "plan_snapshot_json"),
    providerSnapshotJson: text(row, "provider_snapshot_json"),
    detectedAtMs: integer(row, "detected_at_ms"),
    observedAtMs: integer(row, "observed_at_ms"),
    resolvedAtMs: nullableInteger(row, "resolved_at_ms"),
    deviceId: text(row, "device_id"),
    hlcPhysicalMs: integer(row, "hlc_physical_ms"),
    hlcCounter: integer(row, "hlc_counter"),
  };
  validate(record);
  return Object.freeze(record);
}

const COLUMNS = `id, plan_id, plan_workout_id, provider_event_id, provider_revision, status,
plan_snapshot_json, provider_snapshot_json, detected_at_ms, observed_at_ms, resolved_at_ms,
device_id, hlc_physical_ms, hlc_counter`;

type DriftStore = SqlStore & Pick<MigratorStore, "transaction">;

export function createPlanWorkoutDriftRepository(store: DriftStore): PlanWorkoutDriftRepository {
  const read = async (id: string): Promise<PlanWorkoutDriftRecord | undefined> => {
    if (!ULID.test(id)) throw new PlanWorkoutDriftValidationError("invalid-drift");
    const row = await store.get(`SELECT ${COLUMNS} FROM plan_workout_drift WHERE id=?`, [id]);
    return row === undefined ? undefined : fromRow(row);
  };

  return Object.freeze({
    async observe(record: PlanWorkoutDriftRecord) {
      validate(record);
      if (record.status !== "detected") {
        throw new PlanWorkoutDriftValidationError("invalid-drift");
      }
      await store.run(
        `INSERT INTO plan_workout_drift (${COLUMNS})
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (plan_workout_id) WHERE status='detected' DO UPDATE SET
  provider_event_id=excluded.provider_event_id,
  provider_revision=excluded.provider_revision,
  plan_snapshot_json=excluded.plan_snapshot_json,
  provider_snapshot_json=excluded.provider_snapshot_json,
  observed_at_ms=excluded.observed_at_ms,
  device_id=excluded.device_id,
  hlc_physical_ms=excluded.hlc_physical_ms,
  hlc_counter=excluded.hlc_counter`,
        [
          record.id,
          record.planId,
          record.planWorkoutId,
          record.providerEventId,
          record.providerRevision,
          record.status,
          record.planSnapshotJson,
          record.providerSnapshotJson,
          record.detectedAtMs,
          record.observedAtMs,
          record.resolvedAtMs,
          record.deviceId,
          record.hlcPhysicalMs,
          record.hlcCounter,
        ],
      );
      const stored = await store.get(
        `SELECT ${COLUMNS} FROM plan_workout_drift WHERE plan_workout_id=? AND status='detected'`,
        [record.planWorkoutId],
      );
      if (stored === undefined) throw new PlanWorkoutDriftValidationError("missing-drift");
      return fromRow(stored);
    },
    read,
    async readOpenForPlan(planId: string) {
      if (!ULID.test(planId)) throw new PlanWorkoutDriftValidationError("invalid-drift");
      return (
        await store.all(
          `SELECT ${COLUMNS} FROM plan_workout_drift WHERE plan_id=? AND status='detected'
ORDER BY detected_at_ms,id`,
          [planId],
        )
      ).map(fromRow);
    },
    async readOpenForWorkout(planWorkoutId: string) {
      if (!ULID.test(planWorkoutId)) throw new PlanWorkoutDriftValidationError("invalid-drift");
      const row = await store.get(
        `SELECT ${COLUMNS} FROM plan_workout_drift WHERE plan_workout_id=? AND status='detected'`,
        [planWorkoutId],
      );
      return row === undefined ? undefined : fromRow(row);
    },
    async resolve(input: Parameters<PlanWorkoutDriftRepository["resolve"]>[0]) {
      if (
        !ULID.test(input.id) ||
        (input.status !== "adopted" && input.status !== "restored") ||
        !Number.isSafeInteger(input.resolvedAtMs) ||
        input.resolvedAtMs < 0 ||
        !DEVICE_ID.test(input.deviceId) ||
        !Number.isSafeInteger(input.hlcPhysicalMs) ||
        input.hlcPhysicalMs < 0 ||
        !Number.isSafeInteger(input.hlcCounter) ||
        input.hlcCounter < 0
      ) {
        throw new PlanWorkoutDriftValidationError("invalid-drift");
      }
      const current = await read(input.id);
      if (current === undefined) throw new PlanWorkoutDriftValidationError("missing-drift");
      if (current.status !== "detected" || input.resolvedAtMs < current.detectedAtMs) {
        throw new PlanWorkoutDriftValidationError("invalid-transition");
      }
      await store.run(
        `UPDATE plan_workout_drift SET status=?, resolved_at_ms=?, device_id=?,
hlc_physical_ms=?, hlc_counter=? WHERE id=? AND status='detected'`,
        [
          input.status,
          input.resolvedAtMs,
          input.deviceId,
          input.hlcPhysicalMs,
          input.hlcCounter,
          input.id,
        ],
      );
      const stored = await read(input.id);
      if (stored === undefined || stored.status !== input.status) {
        throw new PlanWorkoutDriftValidationError("invalid-transition");
      }
      return stored;
    },
    async adopt(input: Parameters<PlanWorkoutDriftRepository["adopt"]>[0]) {
      if (
        !ULID.test(input.id) ||
        !ULID.test(input.workout.id) ||
        !ULID.test(input.workout.planId) ||
        input.workout.origin !== "coach" ||
        input.workout.name.length === 0 ||
        input.workout.sport.length === 0 ||
        (input.workout.durationS !== null &&
          (!Number.isSafeInteger(input.workout.durationS) || input.workout.durationS <= 0)) ||
        !validJson(input.workout.structureJson) ||
        !Number.isSafeInteger(input.resolvedAtMs) ||
        input.resolvedAtMs < 0 ||
        !DEVICE_ID.test(input.deviceId) ||
        !Number.isSafeInteger(input.hlcPhysicalMs) ||
        input.hlcPhysicalMs < 0 ||
        !Number.isSafeInteger(input.hlcCounter) ||
        input.hlcCounter < 0
      ) {
        throw new PlanWorkoutDriftValidationError("invalid-drift");
      }
      const current = await read(input.id);
      if (current === undefined) throw new PlanWorkoutDriftValidationError("missing-drift");
      if (
        current.status !== "detected" ||
        current.planId !== input.workout.planId ||
        current.planWorkoutId !== input.workout.id ||
        input.resolvedAtMs < current.detectedAtMs
      ) {
        throw new PlanWorkoutDriftValidationError("invalid-transition");
      }
      await store.transaction(async () => {
        await store.run(`UPDATE plan_workout SET
date_key=?, sport=?, name=?, duration_s=?, structure_json=?, origin=?, device_id=?,
hlc_physical_ms=?, hlc_counter=? WHERE id=? AND plan_id=?`, [
          input.workout.dateKey,
          input.workout.sport,
          input.workout.name,
          input.workout.durationS,
          input.workout.structureJson,
          input.workout.origin,
          input.workout.deviceId,
          input.workout.hlcPhysicalMs,
          input.workout.hlcCounter,
          input.workout.id,
          input.workout.planId,
        ]);
        const storedWorkout = await store.get(
          "SELECT id FROM plan_workout WHERE id=? AND plan_id=?",
          [input.workout.id, input.workout.planId],
        );
        if (storedWorkout === undefined) {
          throw new PlanWorkoutDriftValidationError("invalid-transition");
        }
        await store.run(`UPDATE plan_workout_drift SET status='adopted', resolved_at_ms=?,
device_id=?, hlc_physical_ms=?, hlc_counter=? WHERE id=? AND status='detected'`, [
          input.resolvedAtMs,
          input.deviceId,
          input.hlcPhysicalMs,
          input.hlcCounter,
          input.id,
        ]);
      });
      const stored = await read(input.id);
      if (stored === undefined || stored.status !== "adopted") {
        throw new PlanWorkoutDriftValidationError("invalid-transition");
      }
      return stored;
    },
  });
}
