import {
  PlanSeasonProjectionSchema,
  type PlanActiveWorkoutProjection,
  type PlanDraftPlanProjection,
  type PlanSeasonProjection,
} from "@enduragent/coach-contract";

export interface PlanSeasonWeekMetadata {
  readonly phase: string;
  readonly purpose: string;
}

export interface PlanSeasonMetadata {
  readonly weeks: readonly PlanSeasonWeekMetadata[];
  readonly priority: "A" | "B" | "C" | null;
  readonly distanceKm: number | null;
  readonly constraint: {
    readonly weekIndex: number;
    readonly title: string;
    readonly detail: string;
  } | null;
}

function civilDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function civilText(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function addDays(value: string, days: number): string {
  const date = civilDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return civilText(date);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function purpose(name: string, race: boolean): string {
  if (race) return "Race";
  const normalized = name.toLowerCase();
  if (normalized.includes("pre-race")) return "Prime";
  if (normalized.includes("opener")) return "Sharpen";
  if (normalized.includes("recovery")) return "Recover";
  if (normalized.includes("endurance")) return "Maintain";
  return "Train";
}

function raceWeek(input: {
  readonly plan: PlanDraftPlanProjection;
  readonly workouts: readonly PlanActiveWorkoutProjection[];
}): PlanSeasonProjection["raceWeek"] {
  const raceDate = input.plan.targetDate;
  if (raceDate === null) return null;
  const inclusiveDays =
    Math.round(
      (civilDate(raceDate).getTime() - civilDate(input.plan.startDate).getTime()) / 86_400_000,
    ) + 1;
  const raceWeekIndex = Math.min(input.plan.totalWeeks, Math.max(1, Math.ceil(inclusiveDays / 7)));
  const startDate = addDays(input.plan.startDate, (raceWeekIndex - 1) * 7);
  const endDate = addDays(startDate, 6);
  const inWeek = input.workouts.filter(
    (workout) => workout.date >= startDate && workout.date <= endDate,
  );
  const onRaceDate = inWeek
    .filter((workout) => workout.date === raceDate)
    .sort(
      (left, right) =>
        (right.durationS ?? 0) - (left.durationS ?? 0) || left.id.localeCompare(right.id),
    );
  const raceWorkout = onRaceDate[0] ?? null;
  let trainingDurationS = 0;
  const raceDurationS = raceWorkout?.durationS ?? 0;
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = addDays(startDate, index);
    const workouts = inWeek.filter((workout) => workout.date === date);
    const isRace = date === raceDate;
    if (isRace) {
      for (const workout of workouts) {
        if (workout.id !== raceWorkout?.id) trainingDurationS += workout.durationS ?? 0;
      }
      return {
        date,
        weekday: WEEKDAYS[civilDate(date).getUTCDay()],
        workoutId: raceWorkout?.id ?? null,
        name: raceWorkout?.name ?? input.plan.name,
        durationS: raceWorkout?.durationS ?? null,
        purpose: "Race",
        kind: "race" as const,
      };
    }
    const durationS = workouts.reduce((total, workout) => total + (workout.durationS ?? 0), 0);
    trainingDurationS += durationS;
    if (workouts.length === 0) {
      return {
        date,
        weekday: WEEKDAYS[civilDate(date).getUTCDay()],
        workoutId: null,
        name: "Rest",
        durationS: null,
        purpose: "Absorb",
        kind: "rest" as const,
      };
    }
    return {
      date,
      weekday: WEEKDAYS[civilDate(date).getUTCDay()],
      workoutId: workouts.length === 1 ? workouts[0]!.id : null,
      name: workouts.map((workout) => workout.name).join(" + "),
      durationS: durationS > 0 ? durationS : null,
      purpose: purpose(workouts[0]!.name, false),
      kind: "training" as const,
    };
  });
  return {
    startDate,
    endDate,
    raceDate,
    trainingDurationS,
    raceDurationS,
    totalDurationS: trainingDurationS + raceDurationS,
    days,
  };
}

/** Builds the read-only Season and race-week projection from persisted Plan facts. */
export function projectPlanSeason(input: {
  readonly plan: PlanDraftPlanProjection;
  readonly today: string;
  readonly workouts: readonly PlanActiveWorkoutProjection[];
  readonly metadata: PlanSeasonMetadata;
}): PlanSeasonProjection {
  const weeks = Array.from({ length: input.plan.totalWeeks }, (_, index) => {
    const weekIndex = index + 1;
    const startDate = addDays(input.plan.startDate, index * 7);
    const endDate = addDays(startDate, 6);
    const plannedDurationS = input.workouts
      .filter((workout) => workout.date >= startDate && workout.date <= endDate)
      .reduce((total, workout) => total + (workout.durationS ?? 0), 0);
    const metadata = input.metadata.weeks[index] ?? {
      phase: "Plan",
      purpose: "Follow the approved week",
    };
    const containsRace =
      input.plan.targetDate !== null &&
      input.plan.targetDate >= startDate &&
      input.plan.targetDate <= endDate;
    const status =
      input.metadata.constraint?.weekIndex === weekIndex
        ? ("blocked" as const)
        : input.today > endDate
          ? ("completed" as const)
          : input.today >= startDate
            ? ("current" as const)
            : ("planned" as const);
    return {
      weekIndex,
      startDate,
      endDate,
      phase: containsRace ? "Race" : metadata.phase,
      purpose: containsRace ? "Goal race" : metadata.purpose,
      status,
      plannedDurationS,
    };
  });
  return PlanSeasonProjectionSchema.parse({
    priority: input.metadata.priority,
    distanceKm: input.metadata.distanceKm,
    weeks,
    constraint: input.metadata.constraint,
    raceWeek: raceWeek({ plan: input.plan, workouts: input.workouts }),
  });
}
