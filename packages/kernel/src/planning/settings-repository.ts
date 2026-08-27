import type { Row, SqlStore } from "../store/ports.js";

export type PlanSetting = "auto-apply" | "weekly-review";

export interface PlanSettingsRecord {
  readonly planId: string;
  readonly autoApply: boolean;
  readonly weeklyReview: boolean;
  readonly updatedAtMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface PlanSettingsRepository {
  read(planId: string): Promise<PlanSettingsRecord | undefined>;
  save(input: {
    readonly planId: string;
    readonly setting: PlanSetting;
    readonly value: boolean;
    readonly expectedUpdatedAtMs: number;
    readonly expectedHlcPhysicalMs: number;
    readonly expectedHlcCounter: number;
    readonly updatedAtMs: number;
    readonly deviceId: string;
    readonly hlcPhysicalMs: number;
    readonly hlcCounter: number;
  }): Promise<PlanSettingsRecord>;
}

export class PlanSettingsValidationError extends Error {
  readonly code: "invalid-settings" | "missing-settings" | "stale-settings";

  constructor(code: PlanSettingsValidationError["code"]) {
    super(`plan settings rejected: ${code}`);
    this.name = "PlanSettingsValidationError";
    this.code = code;
  }
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function integer(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new PlanSettingsValidationError("invalid-settings");
  }
  return value;
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new PlanSettingsValidationError("invalid-settings");
  return value;
}

function bool(row: Row, key: string): boolean {
  const value = integer(row, key);
  if (value !== 0 && value !== 1) throw new PlanSettingsValidationError("invalid-settings");
  return value === 1;
}

function fromRow(row: Row): PlanSettingsRecord {
  const record: PlanSettingsRecord = {
    planId: text(row, "plan_id"),
    autoApply: bool(row, "auto_apply"),
    weeklyReview: bool(row, "weekly_review"),
    updatedAtMs: integer(row, "updated_at_ms"),
    deviceId: text(row, "device_id"),
    hlcPhysicalMs: integer(row, "hlc_physical_ms"),
    hlcCounter: integer(row, "hlc_counter"),
  };
  if (
    !ULID.test(record.planId) ||
    record.updatedAtMs < 0 ||
    !DEVICE_ID.test(record.deviceId) ||
    record.hlcPhysicalMs < 0 ||
    record.hlcCounter < 0
  ) {
    throw new PlanSettingsValidationError("invalid-settings");
  }
  return Object.freeze(record);
}

const COLUMNS = `plan_id, auto_apply, weekly_review, updated_at_ms, device_id,
hlc_physical_ms, hlc_counter`;

export function createPlanSettingsRepository(store: SqlStore): PlanSettingsRepository {
  const read = async (planId: string): Promise<PlanSettingsRecord | undefined> => {
    if (!ULID.test(planId)) throw new PlanSettingsValidationError("invalid-settings");
    const row = await store.get(`SELECT ${COLUMNS} FROM plan_settings WHERE plan_id=?`, [planId]);
    return row === undefined ? undefined : fromRow(row);
  };

  return Object.freeze({
    read,
    async save(input: Parameters<PlanSettingsRepository["save"]>[0]) {
      if (
        !ULID.test(input.planId) ||
        (input.setting !== "auto-apply" && input.setting !== "weekly-review") ||
        typeof input.value !== "boolean" ||
        !Number.isSafeInteger(input.expectedUpdatedAtMs) ||
        input.expectedUpdatedAtMs < 0 ||
        !Number.isSafeInteger(input.expectedHlcPhysicalMs) ||
        input.expectedHlcPhysicalMs < 0 ||
        !Number.isSafeInteger(input.expectedHlcCounter) ||
        input.expectedHlcCounter < 0 ||
        !Number.isSafeInteger(input.updatedAtMs) ||
        input.updatedAtMs < input.expectedUpdatedAtMs ||
        !DEVICE_ID.test(input.deviceId) ||
        !Number.isSafeInteger(input.hlcPhysicalMs) ||
        input.hlcPhysicalMs < 0 ||
        !Number.isSafeInteger(input.hlcCounter) ||
        input.hlcCounter < 0
      ) {
        throw new PlanSettingsValidationError("invalid-settings");
      }
      const column = input.setting === "auto-apply" ? "auto_apply" : "weekly_review";
      await store.run(
        `UPDATE plan_settings SET ${column}=?, updated_at_ms=?, device_id=?,
hlc_physical_ms=?, hlc_counter=? WHERE plan_id=? AND updated_at_ms=?
AND hlc_physical_ms=? AND hlc_counter=?`,
        [
          input.value ? 1 : 0,
          input.updatedAtMs,
          input.deviceId,
          input.hlcPhysicalMs,
          input.hlcCounter,
          input.planId,
          input.expectedUpdatedAtMs,
          input.expectedHlcPhysicalMs,
          input.expectedHlcCounter,
        ],
      );
      const stored = await read(input.planId);
      if (stored === undefined) throw new PlanSettingsValidationError("missing-settings");
      if (
        stored.updatedAtMs !== input.updatedAtMs ||
        stored.deviceId !== input.deviceId ||
        stored.hlcPhysicalMs !== input.hlcPhysicalMs ||
        stored.hlcCounter !== input.hlcCounter ||
        (input.setting === "auto-apply" ? stored.autoApply : stored.weeklyReview) !== input.value
      ) {
        throw new PlanSettingsValidationError("stale-settings");
      }
      return stored;
    },
  });
}
