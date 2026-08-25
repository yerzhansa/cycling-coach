import type { PlanKind, PlanRecord, PlanStatus, PlanWorkoutRecord } from "./repository.js";
import {
  MIN_FULL_PLAN_DAYS,
  MIN_FULL_PLAN_WEEKS,
  dateKeyFromText,
  inclusiveCivilDays,
  weekdayForDateKey,
} from "./date-keys.js";

export interface PlanningIdentity {
  readonly deviceId: string;
  newId(): string;
  stamp(): { readonly physicalMs: number; readonly counter: number };
}

export interface LegacyPlanRows {
  readonly plan: PlanRecord;
  readonly workouts: readonly PlanWorkoutRecord[];
}

export class LegacyPlanError extends Error {
  readonly code: "invalid-plan" | "invalid-workout";

  constructor(code: LegacyPlanError["code"]) {
    super(`legacy plan rejected: ${code}`);
    this.name = "LegacyPlanError";
    this.code = code;
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LegacyPlanError("invalid-plan");
  }
  return value as Record<string, unknown>;
}

function optionalDate(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new LegacyPlanError("invalid-plan");
  return dateKeyFromText(value);
}

function dateOrFallback(value: unknown, fallback: number): number {
  if (typeof value !== "string") return fallback;
  try {
    return dateKeyFromText(value);
  } catch {
    return fallback;
  }
}

function integer(value: unknown, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new LegacyPlanError("invalid-plan");
  }
  return value;
}

function instant(value: unknown, fallback: number): number {
  if (typeof value !== "string") return fallback;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function status(value: unknown): PlanStatus {
  if (value === undefined) return "draft";
  if (value === "draft" || value === "active" || value === "ended") return value;
  throw new LegacyPlanError("invalid-plan");
}

function kind(startDateKey: number, targetDateKey: number | null, totalWeeks: number): PlanKind {
  if (targetDateKey === null) {
    return totalWeeks >= MIN_FULL_PLAN_WEEKS ? "full_plan" : "short_race_preparation";
  }
  return inclusiveCivilDays(startDateKey, targetDateKey) >= MIN_FULL_PLAN_DAYS
    ? "full_plan"
    : "short_race_preparation";
}

function workoutRows(
  planId: string,
  value: unknown,
  identity: PlanningIdentity,
): readonly PlanWorkoutRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new LegacyPlanError("invalid-workout");
  return value.map((item) => {
    const source = record(item);
    const dateValue = source.dateKey ?? source.date;
    const dateKey = typeof dateValue === "number"
      ? dateValue
      : typeof dateValue === "string"
        ? dateKeyFromText(dateValue)
        : undefined;
    if (
      dateKey === undefined
      || typeof source.sport !== "string"
      || source.sport.length === 0
      || typeof source.name !== "string"
      || source.name.length === 0
    ) {
      throw new LegacyPlanError("invalid-workout");
    }
    const duration = source.durationS ?? source.totalDuration;
    if (
      duration !== undefined
      && (typeof duration !== "number" || !Number.isSafeInteger(duration) || duration <= 0)
    ) {
      throw new LegacyPlanError("invalid-workout");
    }
    const origin = source.origin === undefined ? "coach" : source.origin;
    if (origin !== "coach" && origin !== "athlete") {
      throw new LegacyPlanError("invalid-workout");
    }
    const stamp = identity.stamp();
    return Object.freeze({
      id: identity.newId(),
      planId,
      dateKey,
      sport: source.sport,
      name: source.name,
      durationS: duration ?? null,
      structureJson: JSON.stringify(source),
      origin,
      deviceId: identity.deviceId,
      hlcPhysicalMs: stamp.physicalMs,
      hlcCounter: stamp.counter,
    });
  });
}

export function legacyPlanRows(input: {
  readonly value: unknown;
  readonly identity: PlanningIdentity;
  readonly fallbackDateKey: number;
  readonly fallbackTimestampMs: number;
  readonly existingPlanId?: string;
}): LegacyPlanRows {
  const source = record(input.value);
  if (typeof source.name !== "string") throw new LegacyPlanError("invalid-plan");
  const primaryGoal = source.primaryGoal === undefined ? "" : source.primaryGoal;
  if (typeof primaryGoal !== "string") throw new LegacyPlanError("invalid-plan");
  const totalWeeks = integer(source.totalWeeks, 1);
  const createdAtMs = instant(source.createdAt, input.fallbackTimestampMs);
  const updatedAtMs = Math.max(createdAtMs, instant(source.updatedAt, createdAtMs));
  const startDateKey = optionalDate(source.startDate)
    ?? dateOrFallback(source.createdAt, input.fallbackDateKey);
  const targetDateKey = optionalDate(source.targetDate);
  const originId = source.id === undefined ? null : source.id;
  if (originId !== null && (typeof originId !== "string" || originId.length === 0)) {
    throw new LegacyPlanError("invalid-plan");
  }
  const stamp = input.identity.stamp();
  const planId = input.existingPlanId ?? input.identity.newId();
  const plan: PlanRecord = Object.freeze({
    id: planId,
    originId,
    name: source.name,
    primaryGoal,
    startDateKey,
    targetDateKey,
    status: status(source.status),
    kind: kind(startDateKey, targetDateKey, totalWeeks),
    totalWeeks,
    weekStartDay: weekdayForDateKey(startDateKey),
    structureJson: JSON.stringify(source),
    createdAtMs,
    updatedAtMs,
    deviceId: input.identity.deviceId,
    hlcPhysicalMs: stamp.physicalMs,
    hlcCounter: stamp.counter,
  });
  return Object.freeze({
    plan,
    workouts: workoutRows(planId, source.workouts, input.identity),
  });
}
