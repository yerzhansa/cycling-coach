import {
  GetPlanningReadModelRpcParamsSchema,
  GetPlanningReadModelRpcResultSchema,
  type GetPlanningReadModelRpcParams,
  type GetPlanningReadModelRpcResult,
  type PlanWorkoutReadModel,
} from "@enduragent/coach-contract";
import {
  createPlanRepository,
  createPlanWorkoutRepository,
  planWeekIndex,
  planWeekRange,
  type PlanRow,
  type PlanWorkoutRow,
  type SqlStore,
} from "@enduragent/kernel/store";

export interface PlanningReadService {
  getPlanningReadModel(
    request: GetPlanningReadModelRpcParams,
  ): Promise<GetPlanningReadModelRpcResult>;
}

export interface PlanningReadServiceInput {
  readonly store: SqlStore;
  readonly timezone: string;
  readonly now?: () => number;
}

function todayInTimezone(nowMs: number, timezone: string): number {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(nowMs)).map((part) => [part.type, part.value]),
  );
  return Number(`${parts.year}${parts.month}${parts.day}`);
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function phaseForWeek(plan: PlanRow, weekIndex: number | null): string | null {
  if (weekIndex === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(plan.structure_json) as unknown;
  } catch {
    return null;
  }
  if (!record(parsed) || !Array.isArray(parsed.phases)) return null;
  let throughWeek = 0;
  for (const candidate of parsed.phases) {
    if (!record(candidate)) continue;
    const duration = candidate.durationWeeks;
    if (!Number.isSafeInteger(duration) || Number(duration) < 1) continue;
    throughWeek += Number(duration);
    if (weekIndex > throughWeek) continue;
    const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
    if (name.length > 0) return name;
    const focus = typeof candidate.focus === "string" ? candidate.focus.trim() : "";
    return focus.length > 0 ? focus.replaceAll("_", " ") : null;
  }
  return null;
}

function workoutReadModel(row: PlanWorkoutRow): PlanWorkoutReadModel {
  return {
    id: row.id,
    dateKey: row.date_key,
    sport: row.sport,
    name: row.name,
    durationSeconds: row.duration_s,
    origin: row.origin,
    navigation: { destination: "plan", focus: "workout", entityId: row.id },
  };
}

export function createPlanningReadService(input: PlanningReadServiceInput): PlanningReadService {
  const plans = createPlanRepository(input.store);
  const workouts = createPlanWorkoutRepository(input.store);
  const now = input.now ?? Date.now;

  return {
    async getPlanningReadModel(request) {
      GetPlanningReadModelRpcParamsSchema.parse(request);
      const asOfDateKey = todayInTimezone(now(), input.timezone);
      const plan = await plans.readCurrent();
      if (plan === undefined) {
        return GetPlanningReadModelRpcResultSchema.parse({
          schemaVersion: 1,
          status: "no-plan",
          asOfDateKey,
          plan: null,
        });
      }

      const week = planWeekIndex(plan, asOfDateKey);
      const currentWeek = week.kind === "inside" ? week.weekIndex : null;
      const range = currentWeek === null ? null : planWeekRange(plan, currentWeek);
      const planWorkouts = await workouts.listForPlan(plan.id);
      const currentWorkouts =
        range === null
          ? []
          : planWorkouts
              .filter(
                (workout) =>
                  workout.date_key >= range.startDateKey && workout.date_key <= range.endDateKey,
              )
              .map(workoutReadModel);
      const todayWorkout = currentWorkouts.find((workout) => workout.dateKey === asOfDateKey) ?? null;

      return GetPlanningReadModelRpcResultSchema.parse({
        schemaVersion: 1,
        status: "ready",
        asOfDateKey,
        plan: {
          id: plan.id,
          name: plan.name,
          goal: plan.primary_goal,
          lifecycle: plan.status === "draft" ? "draft" : "active",
          startDateKey: plan.start_date_key,
          targetDateKey: plan.target_date_key,
          currentWeek,
          totalWeeks: plan.total_weeks,
          phase: phaseForWeek(plan, currentWeek),
          weekStartDateKey: range?.startDateKey ?? null,
          weekEndDateKey: range?.endDateKey ?? null,
          workouts: currentWorkouts,
          todayWorkout,
          navigation: { destination: "plan", focus: "active-plan", entityId: plan.id },
        },
      });
    },
  };
}
