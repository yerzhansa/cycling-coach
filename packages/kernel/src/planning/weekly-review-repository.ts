import type { MigratorStore } from "../store/migrator.js";
import type { Row, SqlStore } from "../store/ports.js";

export type PlanWeeklyReviewStatus = "pending" | "delivered";

export interface PlanWeeklyReviewRecord {
  readonly id: string;
  readonly planId: string;
  readonly weekStartDateKey: number;
  readonly weekEndDateKey: number;
  readonly status: PlanWeeklyReviewStatus;
  readonly lastAttemptSyncAtMs: number;
  readonly summaryJson: string | null;
  readonly deliveredAtMs: number | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface PlanWeeklyReviewRepository {
  readForWeek(
    planId: string,
    weekStartDateKey: number,
  ): Promise<PlanWeeklyReviewRecord | undefined>;
  readLatestDelivered(planId: string): Promise<PlanWeeklyReviewRecord | undefined>;
  beginAttempt(record: PlanWeeklyReviewRecord): Promise<{
    readonly record: PlanWeeklyReviewRecord;
    readonly started: boolean;
  }>;
  complete(input: {
    readonly id: string;
    readonly summaryJson: string;
    readonly deliveredAtMs: number;
    readonly updatedAtMs: number;
    readonly deviceId: string;
    readonly hlcPhysicalMs: number;
    readonly hlcCounter: number;
  }): Promise<PlanWeeklyReviewRecord>;
}

export class PlanWeeklyReviewValidationError extends Error {
  readonly code: "invalid-review" | "missing-review" | "invalid-transition";

  constructor(code: PlanWeeklyReviewValidationError["code"]) {
    super(`plan weekly review rejected: ${code}`);
    this.name = "PlanWeeklyReviewValidationError";
    this.code = code;
  }
}

type PlanningStore = SqlStore & Pick<MigratorStore, "transaction">;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function integer(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new PlanWeeklyReviewValidationError("invalid-review");
  }
  return value;
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new PlanWeeklyReviewValidationError("invalid-review");
  return value;
}

function nullableText(row: Row, key: string): string | null {
  const value = row[key];
  if (value !== null && typeof value !== "string") {
    throw new PlanWeeklyReviewValidationError("invalid-review");
  }
  return value;
}

function nullableInteger(row: Row, key: string): number | null {
  const value = row[key];
  if (value !== null && (typeof value !== "number" || !Number.isSafeInteger(value))) {
    throw new PlanWeeklyReviewValidationError("invalid-review");
  }
  return value;
}

function validJson(value: string | null): boolean {
  if (value === null) return true;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function validDateKey(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 10_101 && value <= 99_991_231;
}

function validate(record: PlanWeeklyReviewRecord): void {
  if (
    !ULID.test(record.id) ||
    !ULID.test(record.planId) ||
    !validDateKey(record.weekStartDateKey) ||
    !validDateKey(record.weekEndDateKey) ||
    record.weekEndDateKey < record.weekStartDateKey ||
    (record.status !== "pending" && record.status !== "delivered") ||
    !Number.isSafeInteger(record.lastAttemptSyncAtMs) ||
    record.lastAttemptSyncAtMs < 0 ||
    !validJson(record.summaryJson) ||
    !Number.isSafeInteger(record.createdAtMs) ||
    record.createdAtMs < 0 ||
    !Number.isSafeInteger(record.updatedAtMs) ||
    record.updatedAtMs < record.createdAtMs ||
    !DEVICE_ID.test(record.deviceId) ||
    !Number.isSafeInteger(record.hlcPhysicalMs) ||
    record.hlcPhysicalMs < 0 ||
    !Number.isSafeInteger(record.hlcCounter) ||
    record.hlcCounter < 0 ||
    (record.status === "pending" &&
      (record.summaryJson !== null || record.deliveredAtMs !== null)) ||
    (record.status === "delivered" &&
      (record.summaryJson === null ||
        record.deliveredAtMs === null ||
        !Number.isSafeInteger(record.deliveredAtMs) ||
        record.deliveredAtMs < record.createdAtMs))
  ) {
    throw new PlanWeeklyReviewValidationError("invalid-review");
  }
}

function fromRow(row: Row): PlanWeeklyReviewRecord {
  const record: PlanWeeklyReviewRecord = {
    id: text(row, "id"),
    planId: text(row, "plan_id"),
    weekStartDateKey: integer(row, "week_start_date_key"),
    weekEndDateKey: integer(row, "week_end_date_key"),
    status: text(row, "status") as PlanWeeklyReviewStatus,
    lastAttemptSyncAtMs: integer(row, "last_attempt_sync_at_ms"),
    summaryJson: nullableText(row, "summary_json"),
    deliveredAtMs: nullableInteger(row, "delivered_at_ms"),
    createdAtMs: integer(row, "created_at_ms"),
    updatedAtMs: integer(row, "updated_at_ms"),
    deviceId: text(row, "device_id"),
    hlcPhysicalMs: integer(row, "hlc_physical_ms"),
    hlcCounter: integer(row, "hlc_counter"),
  };
  validate(record);
  return Object.freeze(record);
}

const COLUMNS = `id, plan_id, week_start_date_key, week_end_date_key, status,
last_attempt_sync_at_ms, summary_json, delivered_at_ms, created_at_ms, updated_at_ms,
device_id, hlc_physical_ms, hlc_counter`;

export function createPlanWeeklyReviewRepository(store: PlanningStore): PlanWeeklyReviewRepository {
  const readById = async (id: string): Promise<PlanWeeklyReviewRecord | undefined> => {
    const row = await store.get(`SELECT ${COLUMNS} FROM plan_weekly_review WHERE id=?`, [id]);
    return row === undefined ? undefined : fromRow(row);
  };
  const readForWeek = async (
    planId: string,
    weekStartDateKey: number,
  ): Promise<PlanWeeklyReviewRecord | undefined> => {
    if (!ULID.test(planId) || !validDateKey(weekStartDateKey)) {
      throw new PlanWeeklyReviewValidationError("invalid-review");
    }
    const row = await store.get(
      `SELECT ${COLUMNS} FROM plan_weekly_review WHERE plan_id=? AND week_start_date_key=?`,
      [planId, weekStartDateKey],
    );
    return row === undefined ? undefined : fromRow(row);
  };
  return Object.freeze({
    readForWeek,
    async readLatestDelivered(planId: string) {
      if (!ULID.test(planId)) throw new PlanWeeklyReviewValidationError("invalid-review");
      const row = await store.get(
        `SELECT ${COLUMNS} FROM plan_weekly_review WHERE plan_id=? AND status='delivered'
ORDER BY week_start_date_key DESC,id LIMIT 1`,
        [planId],
      );
      return row === undefined ? undefined : fromRow(row);
    },
    async beginAttempt(record: PlanWeeklyReviewRecord) {
      validate(record);
      if (record.status !== "pending") {
        throw new PlanWeeklyReviewValidationError("invalid-review");
      }
      return store.transaction(async () => {
        const current = await readForWeek(record.planId, record.weekStartDateKey);
        if (current === undefined) {
          await store.run(
            `INSERT INTO plan_weekly_review (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              record.id,
              record.planId,
              record.weekStartDateKey,
              record.weekEndDateKey,
              record.status,
              record.lastAttemptSyncAtMs,
              null,
              null,
              record.createdAtMs,
              record.updatedAtMs,
              record.deviceId,
              record.hlcPhysicalMs,
              record.hlcCounter,
            ],
          );
          return Object.freeze({ record, started: true });
        }
        if (
          current.status === "delivered" ||
          current.lastAttemptSyncAtMs >= record.lastAttemptSyncAtMs
        ) {
          return Object.freeze({ record: current, started: false });
        }
        await store.run(
          `UPDATE plan_weekly_review SET last_attempt_sync_at_ms=?,updated_at_ms=?,device_id=?,
hlc_physical_ms=?,hlc_counter=? WHERE id=? AND status='pending'`,
          [
            record.lastAttemptSyncAtMs,
            record.updatedAtMs,
            record.deviceId,
            record.hlcPhysicalMs,
            record.hlcCounter,
            current.id,
          ],
        );
        const updated = await readById(current.id);
        if (updated === undefined) throw new PlanWeeklyReviewValidationError("missing-review");
        return Object.freeze({ record: updated, started: true });
      });
    },
    async complete(input: Parameters<PlanWeeklyReviewRepository["complete"]>[0]) {
      if (
        !ULID.test(input.id) ||
        !validJson(input.summaryJson) ||
        input.summaryJson.length === 0 ||
        !Number.isSafeInteger(input.deliveredAtMs) ||
        input.deliveredAtMs < 0 ||
        !Number.isSafeInteger(input.updatedAtMs) ||
        input.updatedAtMs < input.deliveredAtMs ||
        !DEVICE_ID.test(input.deviceId) ||
        !Number.isSafeInteger(input.hlcPhysicalMs) ||
        input.hlcPhysicalMs < 0 ||
        !Number.isSafeInteger(input.hlcCounter) ||
        input.hlcCounter < 0
      ) {
        throw new PlanWeeklyReviewValidationError("invalid-review");
      }
      const current = await readById(input.id);
      if (current === undefined) throw new PlanWeeklyReviewValidationError("missing-review");
      if (current.status === "delivered") return current;
      if (input.deliveredAtMs < current.createdAtMs || input.updatedAtMs < current.updatedAtMs) {
        throw new PlanWeeklyReviewValidationError("invalid-transition");
      }
      await store.run(
        `UPDATE plan_weekly_review SET status='delivered',summary_json=?,delivered_at_ms=?,
updated_at_ms=?,device_id=?,hlc_physical_ms=?,hlc_counter=? WHERE id=? AND status='pending'`,
        [
          input.summaryJson,
          input.deliveredAtMs,
          input.updatedAtMs,
          input.deviceId,
          input.hlcPhysicalMs,
          input.hlcCounter,
          input.id,
        ],
      );
      const completed = await readById(input.id);
      if (completed === undefined || completed.status !== "delivered") {
        throw new PlanWeeklyReviewValidationError("invalid-transition");
      }
      return completed;
    },
  });
}
