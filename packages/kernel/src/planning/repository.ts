import type { MigratorStore } from "../store/migrator.js";
import type { Row, SqlStore } from "../store/ports.js";
import { derivePlanKind, minimumWeeksToCover, weekdayForDateKey } from "./date-key.js";
import {
  PlanningInvariantError,
  type PlanAggregateRepository,
  type PlanRepository,
  type PlanRow,
  type PlanWorkoutRepository,
  type PlanWorkoutRow,
} from "./types.js";

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function validJson(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

export function validatePlanRow(row: PlanRow): void {
  if (!ULID.test(row.id)) throw new PlanningInvariantError("invalid_id", "plan id is invalid");
  if (row.origin_id !== null && row.origin_id.length === 0) {
    throw new PlanningInvariantError("invalid_origin_id", "plan origin id is invalid");
  }
  if (row.name.trim().length === 0) throw new PlanningInvariantError("invalid_name", "plan name is invalid");
  if (row.status !== "draft" && row.status !== "active" && row.status !== "ended") {
    throw new PlanningInvariantError("invalid_status", "plan status is invalid");
  }
  if (row.kind !== "full_plan" && row.kind !== "short_race_preparation") {
    throw new PlanningInvariantError("invalid_kind", "plan kind is invalid");
  }
  if (!Number.isSafeInteger(row.total_weeks) || row.total_weeks < 1) {
    throw new PlanningInvariantError("invalid_total_weeks", "plan total weeks is invalid");
  }
  const weekday = weekdayForDateKey(row.start_date_key);
  if (!Number.isSafeInteger(row.week_start_day) || row.week_start_day < 0 || row.week_start_day > 6) {
    throw new PlanningInvariantError("invalid_week_start_day", "plan week start day is invalid");
  }
  if (row.week_start_day !== weekday) {
    throw new PlanningInvariantError("inconsistent_week_start_day", "plan week start day disagrees with start date");
  }
  if (row.target_date_key !== null) {
    const requiredWeeks = minimumWeeksToCover(row.start_date_key, row.target_date_key);
    if (row.total_weeks < requiredWeeks) {
      throw new PlanningInvariantError("target_not_covered", "plan total weeks do not cover the target");
    }
  }
  if (row.kind !== derivePlanKind(row.start_date_key, row.target_date_key, row.total_weeks)) {
    throw new PlanningInvariantError("inconsistent_kind", "plan kind disagrees with its duration");
  }
  if (!validJson(row.structure_json)) throw new PlanningInvariantError("invalid_json", "plan structure is invalid JSON");
  if (
    !Number.isSafeInteger(row.created_at_ms) || row.created_at_ms < 0 ||
    !Number.isSafeInteger(row.updated_at_ms) || row.updated_at_ms < row.created_at_ms
  ) {
    throw new PlanningInvariantError("invalid_timestamp", "plan timestamps are invalid");
  }
  if (
    !DEVICE_ID.test(row.device_id) ||
    !Number.isSafeInteger(row.hlc_physical_ms) || row.hlc_physical_ms < 0 ||
    !Number.isSafeInteger(row.hlc_counter) || row.hlc_counter < 0
  ) {
    throw new PlanningInvariantError("invalid_authored_stamp", "plan authored stamp is invalid");
  }
}

export function validatePlanWorkoutRow(row: PlanWorkoutRow): void {
  if (!ULID.test(row.id)) throw new PlanningInvariantError("invalid_id", "plan workout id is invalid");
  if (!ULID.test(row.plan_id)) throw new PlanningInvariantError("invalid_plan_id", "plan workout plan id is invalid");
  weekdayForDateKey(row.date_key);
  if (row.sport.trim().length === 0) throw new PlanningInvariantError("invalid_sport", "plan workout sport is invalid");
  if (row.name.trim().length === 0) throw new PlanningInvariantError("invalid_name", "plan workout name is invalid");
  if (row.duration_s !== null && (!Number.isSafeInteger(row.duration_s) || row.duration_s < 0)) {
    throw new PlanningInvariantError("invalid_duration", "plan workout duration is invalid");
  }
  if (!validJson(row.structure_json)) throw new PlanningInvariantError("invalid_json", "plan workout structure is invalid JSON");
  if (row.origin !== "coach" && row.origin !== "athlete") {
    throw new PlanningInvariantError("invalid_origin", "plan workout origin is invalid");
  }
  if (
    !DEVICE_ID.test(row.device_id) ||
    !Number.isSafeInteger(row.hlc_physical_ms) || row.hlc_physical_ms < 0 ||
    !Number.isSafeInteger(row.hlc_counter) || row.hlc_counter < 0
  ) {
    throw new PlanningInvariantError("invalid_authored_stamp", "plan workout authored stamp is invalid");
  }
}

function mapPlan(row: Row): PlanRow {
  const value: PlanRow = {
    id: String(row.id), origin_id: row.origin_id === null ? null : String(row.origin_id),
    name: String(row.name), primary_goal: String(row.primary_goal),
    start_date_key: Number(row.start_date_key), target_date_key: row.target_date_key === null ? null : Number(row.target_date_key),
    status: String(row.status) as PlanRow["status"], kind: String(row.kind) as PlanRow["kind"],
    total_weeks: Number(row.total_weeks), week_start_day: Number(row.week_start_day),
    structure_json: String(row.structure_json), created_at_ms: Number(row.created_at_ms), updated_at_ms: Number(row.updated_at_ms),
    device_id: String(row.device_id), hlc_physical_ms: Number(row.hlc_physical_ms), hlc_counter: Number(row.hlc_counter),
  };
  validatePlanRow(value);
  return value;
}

function mapWorkout(row: Row): PlanWorkoutRow {
  const value: PlanWorkoutRow = {
    id: String(row.id), plan_id: String(row.plan_id), date_key: Number(row.date_key), sport: String(row.sport),
    name: String(row.name), duration_s: row.duration_s === null ? null : Number(row.duration_s),
    structure_json: String(row.structure_json), origin: String(row.origin) as PlanWorkoutRow["origin"],
    device_id: String(row.device_id), hlc_physical_ms: Number(row.hlc_physical_ms), hlc_counter: Number(row.hlc_counter),
  };
  validatePlanWorkoutRow(value);
  return value;
}

const PLAN_COLUMNS = "id,origin_id,name,primary_goal,start_date_key,target_date_key,status,kind,total_weeks,week_start_day,structure_json,created_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter";
const WORKOUT_COLUMNS = "id,plan_id,date_key,sport,name,duration_s,structure_json,origin,device_id,hlc_physical_ms,hlc_counter";

async function writePlan(store: SqlStore, row: PlanRow): Promise<void> {
  validatePlanRow(row);
  await store.run(`INSERT INTO plan (${PLAN_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET origin_id=excluded.origin_id,name=excluded.name,primary_goal=excluded.primary_goal,start_date_key=excluded.start_date_key,target_date_key=excluded.target_date_key,status=excluded.status,kind=excluded.kind,total_weeks=excluded.total_weeks,week_start_day=excluded.week_start_day,structure_json=excluded.structure_json,updated_at_ms=excluded.updated_at_ms,device_id=excluded.device_id,hlc_physical_ms=excluded.hlc_physical_ms,hlc_counter=excluded.hlc_counter`,
  [row.id,row.origin_id,row.name,row.primary_goal,row.start_date_key,row.target_date_key,row.status,row.kind,row.total_weeks,row.week_start_day,row.structure_json,row.created_at_ms,row.updated_at_ms,row.device_id,row.hlc_physical_ms,row.hlc_counter]);
}

async function writeWorkout(store: SqlStore, row: PlanWorkoutRow): Promise<void> {
  validatePlanWorkoutRow(row);
  await store.run(`INSERT INTO plan_workout (${WORKOUT_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET plan_id=excluded.plan_id,date_key=excluded.date_key,sport=excluded.sport,name=excluded.name,duration_s=excluded.duration_s,structure_json=excluded.structure_json,origin=excluded.origin,device_id=excluded.device_id,hlc_physical_ms=excluded.hlc_physical_ms,hlc_counter=excluded.hlc_counter`,
  [row.id,row.plan_id,row.date_key,row.sport,row.name,row.duration_s,row.structure_json,row.origin,row.device_id,row.hlc_physical_ms,row.hlc_counter]);
}

export function createPlanRepository(store: SqlStore): PlanRepository {
  return {
    upsert: (row) => writePlan(store, row),
    async read(id) { const row = await store.get(`SELECT ${PLAN_COLUMNS} FROM plan WHERE id=?`, [id]); return row === undefined ? undefined : mapPlan(row); },
    async readByOriginId(originId) { const row = await store.get(`SELECT ${PLAN_COLUMNS} FROM plan WHERE origin_id=?`, [originId]); return row === undefined ? undefined : mapPlan(row); },
    async readCurrent() { const row = await store.get(`SELECT ${PLAN_COLUMNS} FROM plan WHERE status!='ended' ORDER BY updated_at_ms DESC, id DESC LIMIT 1`); return row === undefined ? undefined : mapPlan(row); },
    async list() { return (await store.all(`SELECT ${PLAN_COLUMNS} FROM plan ORDER BY created_at_ms ASC,id ASC`)).map(mapPlan); },
    async delete(id) { await store.run("DELETE FROM plan WHERE id=?", [id]); },
  };
}

export function createPlanWorkoutRepository(store: SqlStore): PlanWorkoutRepository {
  return {
    upsert: (row) => writeWorkout(store, row),
    async replaceForPlan(planId, rows) {
      if (!ULID.test(planId)) throw new PlanningInvariantError("invalid_plan_id", "plan id is invalid");
      for (const row of rows) { if (row.plan_id !== planId) throw new PlanningInvariantError("invalid_plan_id", "workout belongs to another plan"); validatePlanWorkoutRow(row); }
      await store.run("DELETE FROM plan_workout WHERE plan_id=?", [planId]);
      for (const row of rows) await writeWorkout(store, row);
    },
    async listForPlan(planId) { return (await store.all(`SELECT ${WORKOUT_COLUMNS} FROM plan_workout WHERE plan_id=? ORDER BY date_key ASC,id ASC`, [planId])).map(mapWorkout); },
  };
}

export function createPlanAggregateRepository(
  store: SqlStore & Pick<MigratorStore, "transaction">,
): PlanAggregateRepository {
  return {
    async save(plan, workouts) {
      validatePlanRow(plan);
      for (const workout of workouts) { if (workout.plan_id !== plan.id) throw new PlanningInvariantError("invalid_plan_id", "workout belongs to another plan"); validatePlanWorkoutRow(workout); }
      await store.transaction(async () => {
        await writePlan(store, plan);
        await store.run("DELETE FROM plan_workout WHERE plan_id=?", [plan.id]);
        for (const workout of workouts) await writeWorkout(store, workout);
      });
    },
  };
}
