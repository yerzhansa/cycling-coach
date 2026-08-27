import type { Row, SqlStore } from "../store/ports.js";

export type PlanRaceOutcome = "completed" | "not-completed";

export interface PlanRaceOutcomeRecord {
  readonly planId: string;
  readonly outcome: PlanRaceOutcome;
  readonly recordedAtMs: number;
  readonly updatedAtMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface PlanRaceOutcomeRepository {
  read(planId: string): Promise<PlanRaceOutcomeRecord | undefined>;
  record(value: PlanRaceOutcomeRecord): Promise<{
    readonly record: PlanRaceOutcomeRecord;
    readonly created: boolean;
  }>;
}

export class PlanRaceOutcomeValidationError extends Error {
  readonly code: "invalid-outcome" | "conflicting-outcome";

  constructor(code: PlanRaceOutcomeValidationError["code"]) {
    super(`plan race outcome rejected: ${code}`);
    this.name = "PlanRaceOutcomeValidationError";
    this.code = code;
  }
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new PlanRaceOutcomeValidationError("invalid-outcome");
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new PlanRaceOutcomeValidationError("invalid-outcome");
  }
  return value;
}

function validate(value: PlanRaceOutcomeRecord): void {
  if (
    !ULID.test(value.planId) ||
    (value.outcome !== "completed" && value.outcome !== "not-completed") ||
    !Number.isSafeInteger(value.recordedAtMs) ||
    value.recordedAtMs < 0 ||
    !Number.isSafeInteger(value.updatedAtMs) ||
    value.updatedAtMs < value.recordedAtMs ||
    !DEVICE_ID.test(value.deviceId) ||
    !Number.isSafeInteger(value.hlcPhysicalMs) ||
    value.hlcPhysicalMs < 0 ||
    !Number.isSafeInteger(value.hlcCounter) ||
    value.hlcCounter < 0
  ) {
    throw new PlanRaceOutcomeValidationError("invalid-outcome");
  }
}

function fromRow(row: Row): PlanRaceOutcomeRecord {
  const record: PlanRaceOutcomeRecord = {
    planId: text(row, "plan_id"),
    outcome: text(row, "outcome") as PlanRaceOutcome,
    recordedAtMs: integer(row, "recorded_at_ms"),
    updatedAtMs: integer(row, "updated_at_ms"),
    deviceId: text(row, "device_id"),
    hlcPhysicalMs: integer(row, "hlc_physical_ms"),
    hlcCounter: integer(row, "hlc_counter"),
  };
  validate(record);
  return Object.freeze(record);
}

const COLUMNS = `plan_id,outcome,recorded_at_ms,updated_at_ms,device_id,
hlc_physical_ms,hlc_counter`;

export function createPlanRaceOutcomeRepository(store: SqlStore): PlanRaceOutcomeRepository {
  const read = async (planId: string): Promise<PlanRaceOutcomeRecord | undefined> => {
    if (!ULID.test(planId)) throw new PlanRaceOutcomeValidationError("invalid-outcome");
    const row = await store.get(`SELECT ${COLUMNS} FROM plan_race_outcome WHERE plan_id=?`, [
      planId,
    ]);
    return row === undefined ? undefined : fromRow(row);
  };
  return Object.freeze({
    read,
    async record(value: Parameters<PlanRaceOutcomeRepository["record"]>[0]) {
      validate(value);
      const current = await read(value.planId);
      if (current !== undefined) {
        if (current.outcome !== value.outcome) {
          throw new PlanRaceOutcomeValidationError("conflicting-outcome");
        }
        return Object.freeze({ record: current, created: false });
      }
      await store.run(`INSERT INTO plan_race_outcome (${COLUMNS}) VALUES (?,?,?,?,?,?,?)`, [
        value.planId,
        value.outcome,
        value.recordedAtMs,
        value.updatedAtMs,
        value.deviceId,
        value.hlcPhysicalMs,
        value.hlcCounter,
      ]);
      return Object.freeze({ record: value, created: true });
    },
  });
}
