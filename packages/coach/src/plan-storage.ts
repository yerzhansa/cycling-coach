import { existsSync, readFileSync, statSync } from "node:fs";
import {
  createPlanAggregateRepository,
  createPlanRepository,
  createPlanWorkoutRepository,
  derivePlanKind,
  minimumWeeksToCover,
  PlanningInvariantError,
  validateNewPlanStart,
  weekdayForDateKey,
  type PlanRow,
  type PlanStatus,
  type PlanWorkoutOrigin,
  type PlanWorkoutRow,
  type SqlStore,
} from "@enduragent/kernel/store";
import type { MigratorStore } from "@enduragent/kernel/store";
import type { PlanPersistencePort } from "@enduragent/engine";
import type { AuthoredIdentity } from "@enduragent/kernel-node/home";

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

interface PlanStorageLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, error?: unknown, fields?: Record<string, unknown>): void;
}

export interface PlanStorageService extends PlanPersistencePort {
  importLegacyPlan(path: string): Promise<"absent" | "imported" | "already-imported" | "skipped">;
}

export interface PlanStorageServiceInput {
  readonly store: SqlStore & MigratorStore;
  readonly identity: AuthoredIdentity;
  readonly timezone: string;
  readonly now?: () => number;
  readonly logger: PlanStorageLogger;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Readonly<Record<string, unknown>>, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function integerField(record: Readonly<Record<string, unknown>>, ...keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (Number.isSafeInteger(value)) return value as number;
  }
  return undefined;
}

function dateKeyFromText(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (match === null) return undefined;
  const result = Number(`${match[1]}${match[2]}${match[3]}`);
  try {
    weekdayForDateKey(result);
    return result;
  } catch {
    return undefined;
  }
}

function dateKeyField(
  record: Readonly<Record<string, unknown>>,
  key: string,
  textKey?: string,
): number | undefined {
  if (record[key] !== undefined) {
    const direct = integerField(record, key);
    if (direct === undefined) {
      throw new PlanningInvariantError("invalid_date_key", `${key} must be a civil date key`);
    }
    weekdayForDateKey(direct);
    return direct;
  }
  if (textKey !== undefined && record[textKey] !== undefined) {
    const parsed = dateKeyFromText(stringField(record, textKey));
    if (parsed === undefined) {
      throw new PlanningInvariantError("invalid_date_key", `${textKey} must begin with a civil date`);
    }
    return parsed;
  }
  return undefined;
}

function todayInTimezone(nowMs: number, timezone: string): number {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const values = Object.fromEntries(
    formatter.formatToParts(new Date(nowMs)).map((part) => [part.type, part.value]),
  );
  return Number(`${values.year}${values.month}${values.day}`);
}

function timestamp(value: unknown, fallback: number): number {
  if (typeof value !== "string") return fallback;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function requiredPositiveInteger(value: unknown, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new PlanningInvariantError("invalid_total_weeks", `${field} must be a positive integer`);
  }
  return Number(value);
}

function statusOf(value: unknown, fallback: PlanStatus): PlanStatus {
  if (value === undefined) return fallback;
  if (value === "draft" || value === "active" || value === "ended") return value;
  throw new PlanningInvariantError("invalid_status", "plan status is invalid");
}

function workoutKey(row: Pick<PlanWorkoutRow, "date_key" | "sport" | "name">): string {
  return `${row.date_key}\u0000${row.sport}\u0000${row.name}`;
}

function normalizedDuration(workout: Readonly<Record<string, unknown>>): number | null {
  const seconds = integerField(workout, "durationS", "duration_s");
  if (seconds !== undefined) return seconds;
  const minutes = integerField(workout, "durationMinutes");
  return minutes === undefined ? null : minutes * 60;
}

export function createPlanStorageService(input: PlanStorageServiceInput): PlanStorageService {
  const now = input.now ?? Date.now;
  const plans = createPlanRepository(input.store);
  const planWorkouts = createPlanWorkoutRepository(input.store);
  const aggregates = createPlanAggregateRepository(input.store);

  const persist = async (
    rawPlan: Readonly<Record<string, unknown>>,
    mode: "save" | "import",
  ): Promise<void> => {
    const observedAt = Math.floor(now());
    const todayDateKey = todayInTimezone(observedAt, input.timezone);
    const sourceId = stringField(rawPlan, "id");
    const existing =
      sourceId !== undefined && !ULID.test(sourceId)
        ? await plans.readByOriginId(sourceId)
        : sourceId !== undefined && ULID.test(sourceId)
          ? await plans.read(sourceId)
          : await plans.readCurrent();
    const planId = existing?.id ?? (sourceId !== undefined && ULID.test(sourceId) ? sourceId : input.identity.newUlid());
    const originId = existing?.origin_id ?? (sourceId !== undefined && !ULID.test(sourceId) ? sourceId : null);
    const createdAtMs = existing?.created_at_ms ?? timestamp(rawPlan.createdAt, observedAt);

    const requestedStart =
      dateKeyField(rawPlan, "startDateKey", "startDate") ??
      dateKeyField(rawPlan, "start_date_key") ??
      dateKeyFromText(stringField(rawPlan, "createdAt"));
    const startDateKey = existing?.start_date_key ?? requestedStart ?? todayDateKey;
    const targetDateKey =
      dateKeyField(rawPlan, "targetDateKey", "targetDate") ?? existing?.target_date_key ?? null;
    if (mode === "save" && existing === undefined) {
      validateNewPlanStart(startDateKey, todayDateKey, targetDateKey);
    } else if (targetDateKey !== null && startDateKey > targetDateKey) {
      throw new PlanningInvariantError("start_after_target", "plan start cannot be after target");
    }
    const fallbackWeeks = targetDateKey === null ? 1 : minimumWeeksToCover(startDateKey, targetDateKey);
    const totalWeeks = requiredPositiveInteger(
      rawPlan.totalWeeks,
      existing?.total_weeks ?? fallbackWeeks,
      "totalWeeks",
    );
    if (targetDateKey !== null && totalWeeks < minimumWeeksToCover(startDateKey, targetDateKey)) {
      throw new PlanningInvariantError("target_not_covered", "totalWeeks does not cover targetDate");
    }
    const deviceId = await input.identity.deviceId();
    const planStamp = input.identity.hlcStamp();
    const name = stringField(rawPlan, "name") ?? existing?.name;
    if (name === undefined) throw new PlanningInvariantError("invalid_name", "plan name is required");
    const plan: PlanRow = {
      id: planId,
      origin_id: originId,
      name,
      primary_goal: stringField(rawPlan, "primaryGoal", "primary_goal") ?? existing?.primary_goal ?? "",
      start_date_key: startDateKey,
      target_date_key: targetDateKey,
      status: statusOf(rawPlan.status, existing?.status ?? "draft"),
      kind: derivePlanKind(startDateKey, targetDateKey, totalWeeks),
      total_weeks: totalWeeks,
      week_start_day: weekdayForDateKey(startDateKey),
      structure_json: JSON.stringify(rawPlan),
      created_at_ms: createdAtMs,
      updated_at_ms: Math.max(createdAtMs, timestamp(rawPlan.updatedAt, observedAt)),
      device_id: deviceId,
      hlc_physical_ms: planStamp.physicalMs,
      hlc_counter: planStamp.counter,
    };

    const priorWorkouts = await planWorkouts.listForPlan(planId);
    const priorIds = new Map(priorWorkouts.map((workout) => [workoutKey(workout), workout.id]));
    const rawWorkouts = rawPlan.workouts;
    if (rawWorkouts !== undefined && !Array.isArray(rawWorkouts)) {
      throw new PlanningInvariantError("invalid_json", "plan workouts must be an array");
    }
    const workouts: PlanWorkoutRow[] = rawWorkouts === undefined ? [...priorWorkouts] : [];
    for (const candidate of rawWorkouts ?? []) {
      if (!isRecord(candidate)) throw new PlanningInvariantError("invalid_json", "plan workout is invalid");
      const dateKey = dateKeyField(candidate, "dateKey", "date");
      const sport = stringField(candidate, "sport");
      const workoutName = stringField(candidate, "name");
      if (dateKey === undefined || sport === undefined || workoutName === undefined) {
        throw new PlanningInvariantError("invalid_json", "plan workout identity is incomplete");
      }
      const key = workoutKey({ date_key: dateKey, sport, name: workoutName });
      const explicitId = stringField(candidate, "id");
      const workoutId = explicitId !== undefined && ULID.test(explicitId)
        ? explicitId
        : priorIds.get(key) ?? input.identity.newUlid();
      const originValue = candidate.origin;
      const origin: PlanWorkoutOrigin = originValue === undefined || originValue === "coach"
        ? "coach"
        : originValue === "athlete"
          ? "athlete"
          : (() => { throw new PlanningInvariantError("invalid_origin", "plan workout origin is invalid"); })();
      const stamp = input.identity.hlcStamp();
      workouts.push({
        id: workoutId,
        plan_id: planId,
        date_key: dateKey,
        sport,
        name: workoutName,
        duration_s: normalizedDuration(candidate),
        structure_json: JSON.stringify(candidate),
        origin,
        device_id: deviceId,
        hlc_physical_ms: stamp.physicalMs,
        hlc_counter: stamp.counter,
      });
    }
    await aggregates.save(plan, workouts);
  };

  return {
    save(plan) {
      return persist(plan, "save");
    },
    async importLegacyPlan(path) {
      if (!existsSync(path)) return "absent";
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
      } catch (error) {
        input.logger.warn("legacy_plan_import_skipped", error, { path, reason: "invalid-json" });
        return "skipped";
      }
      if (!isRecord(parsed)) {
        input.logger.warn("legacy_plan_import_skipped", undefined, { path, reason: "invalid-shape" });
        return "skipped";
      }
      const sourceId = stringField(parsed, "id");
      const alreadyImported = sourceId === undefined
        ? await plans.readCurrent() !== undefined
        : ULID.test(sourceId)
          ? await plans.read(sourceId) !== undefined
          : await plans.readByOriginId(sourceId) !== undefined;
      if (alreadyImported) {
        return "already-imported";
      }
      const before = statSync(path);
      try {
        await persist(parsed, "import");
      } catch (error) {
        input.logger.warn("legacy_plan_import_skipped", error, { path, reason: "invalid-plan" });
        return "skipped";
      }
      const after = statSync(path);
      if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) {
        throw new Error("legacy Plan import modified its source file");
      }
      input.logger.info("legacy_plan_imported", { path });
      return "imported";
    },
  };
}
