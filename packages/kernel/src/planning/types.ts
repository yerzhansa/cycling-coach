export const MIN_FULL_PLAN_WEEKS = 12;
export const MIN_FULL_PLAN_DAYS = 84;

export type PlanStatus = "draft" | "active" | "ended";
export type PlanKind = "full_plan" | "short_race_preparation";
export type PlanWorkoutOrigin = "coach" | "athlete";

export interface PlanRow {
  readonly id: string;
  readonly origin_id: string | null;
  readonly name: string;
  readonly primary_goal: string;
  readonly start_date_key: number;
  readonly target_date_key: number | null;
  readonly status: PlanStatus;
  readonly kind: PlanKind;
  readonly total_weeks: number;
  readonly week_start_day: number;
  readonly structure_json: string;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
  readonly device_id: string;
  readonly hlc_physical_ms: number;
  readonly hlc_counter: number;
}

export interface PlanWorkoutRow {
  readonly id: string;
  readonly plan_id: string;
  readonly date_key: number;
  readonly sport: string;
  readonly name: string;
  readonly duration_s: number | null;
  readonly structure_json: string;
  readonly origin: PlanWorkoutOrigin;
  readonly device_id: string;
  readonly hlc_physical_ms: number;
  readonly hlc_counter: number;
}

export type PlanningInvariantCode =
  | "invalid_id"
  | "invalid_origin_id"
  | "invalid_name"
  | "invalid_date_key"
  | "invalid_status"
  | "invalid_kind"
  | "inconsistent_kind"
  | "invalid_total_weeks"
  | "target_not_covered"
  | "invalid_week_start_day"
  | "inconsistent_week_start_day"
  | "invalid_json"
  | "invalid_timestamp"
  | "invalid_authored_stamp"
  | "invalid_plan_id"
  | "invalid_sport"
  | "invalid_duration"
  | "invalid_origin"
  | "start_before_today"
  | "start_after_target";

export class PlanningInvariantError extends Error {
  constructor(
    readonly code: PlanningInvariantCode,
    message: string,
  ) {
    super(message);
    this.name = "PlanningInvariantError";
  }
}

export interface PlanRepository {
  upsert(row: PlanRow): Promise<void>;
  read(id: string): Promise<PlanRow | undefined>;
  readByOriginId(originId: string): Promise<PlanRow | undefined>;
  readCurrent(): Promise<PlanRow | undefined>;
  list(): Promise<readonly PlanRow[]>;
  delete(id: string): Promise<void>;
}

export interface PlanWorkoutRepository {
  upsert(row: PlanWorkoutRow): Promise<void>;
  replaceForPlan(planId: string, rows: readonly PlanWorkoutRow[]): Promise<void>;
  listForPlan(planId: string): Promise<readonly PlanWorkoutRow[]>;
}

export interface PlanAggregateRepository {
  save(plan: PlanRow, workouts: readonly PlanWorkoutRow[]): Promise<void>;
}
