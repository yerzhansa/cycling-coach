import type { CyclingEstimatedCpProjection } from "./estimated-cp.js";

export interface CyclingPlanReadinessInput {
  readonly today: string;
  readonly raceDate: string | null;
  readonly platformSeed: {
    readonly asOf: string;
    readonly fitness: number;
    readonly fatigue: number;
    readonly lastSuccessfulRefreshAtMs: number | null;
  } | null;
  readonly dailyLoadRanges: readonly {
    readonly date: string;
    readonly min: number;
    readonly max: number;
  }[];
  readonly supportedDistanceKm: { readonly min: number; readonly max: number } | null;
  readonly missedKeyWorkouts: number;
  readonly fatigue: "normal" | "above-normal" | "unknown";
  readonly courseEstimate: {
    readonly status: "available" | "unavailable" | "changed";
    readonly rangeMinutes: { readonly min: number; readonly max: number } | null;
    readonly previousRangeMinutes: { readonly min: number; readonly max: number } | null;
    readonly confidence: "low" | "moderate" | "high" | null;
    readonly assumptions: readonly string[];
    readonly changedAssumption: string | null;
    readonly unavailableReason: "missing-course" | "missing-elevation" | null;
  };
  readonly estimatedCp: CyclingEstimatedCpProjection;
  readonly evidence: {
    readonly prescribedDurationS: number;
    readonly riddenDurationS: number;
    readonly adjustedDurationS: number;
  };
}

export interface CyclingReadinessWorkoutInput {
  readonly date: string;
  readonly name: string;
  readonly durationS: number | null;
  readonly structureJson: string;
}

export interface CyclingReadinessSourceInput {
  readonly today: string;
  readonly raceDate: string | null;
  readonly wellness: unknown;
  readonly currentStatus: unknown;
  readonly estimatedCp: CyclingEstimatedCpProjection;
  readonly lastSuccessfulRefreshAtMs: number | null;
  readonly workouts: readonly CyclingReadinessWorkoutInput[];
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function jsonObject(value: string): Record<string, unknown> | null {
  try {
    return object(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonnegative(value: unknown): number | null {
  const number = finite(value);
  return number !== null && number >= 0 ? number : null;
}

function civilDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function addDays(value: string, days: number): string {
  const date = civilDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function platformSeed(
  wellness: unknown,
  today: string,
  lastSuccessfulRefreshAtMs: number | null,
): CyclingPlanReadinessInput["platformSeed"] {
  if (!Array.isArray(wellness)) return null;
  const rows = wellness
    .map(object)
    .filter((row): row is Record<string, unknown> => row !== null)
    .filter((row) => typeof row.id === "string" && row.id <= today)
    .sort((left, right) => String(right.id).localeCompare(String(left.id)));
  for (const row of rows) {
    const fitness = finite(row.fitness);
    const fatigue = finite(row.fatigue);
    if (fitness !== null && fatigue !== null) {
      return {
        asOf: String(row.id),
        fitness,
        fatigue,
        lastSuccessfulRefreshAtMs,
      };
    }
  }
  return null;
}

function loadRange(value: CyclingReadinessWorkoutInput): { min: number; max: number } | null {
  const parsed = jsonObject(value.structureJson);
  if (parsed === null) return null;
  const explicit = object(parsed.trainingLoadRange);
  if (explicit !== null) {
    const min = nonnegative(explicit.min);
    const max = nonnegative(explicit.max);
    if (min !== null && max !== null && min <= max) return { min, max };
  }
  const load =
    nonnegative(parsed.trainingLoad) ??
    nonnegative(parsed.icuTrainingLoad) ??
    nonnegative(parsed.load);
  return load === null ? null : { min: load, max: load };
}

function dailyLoadRanges(
  today: string,
  raceDate: string | null,
  workouts: readonly CyclingReadinessWorkoutInput[],
): CyclingPlanReadinessInput["dailyLoadRanges"] {
  if (raceDate === null) return [];
  const result: Array<{ date: string; min: number; max: number }> = [];
  for (let date = addDays(today, 1); date <= raceDate; date = addDays(date, 1)) {
    const onDate = workouts.filter((workout) => workout.date === date);
    if (onDate.length === 0) {
      result.push({ date, min: 0, max: 0 });
      continue;
    }
    const ranges = onDate.map(loadRange);
    if (ranges.some((range) => range === null)) continue;
    result.push({
      date,
      min: ranges.reduce((sum, range) => sum + range!.min, 0),
      max: ranges.reduce((sum, range) => sum + range!.max, 0),
    });
  }
  return result;
}

function sourceFacts(
  value: unknown,
): Pick<
  CyclingPlanReadinessInput,
  "supportedDistanceKm" | "missedKeyWorkouts" | "fatigue" | "courseEstimate" | "evidence"
> {
  const root = object(value);
  const readiness = object(root?.readiness) ?? root ?? {};
  const supported = object(readiness.supportedDistanceKm);
  const supportedMin = nonnegative(supported?.min);
  const supportedMax = nonnegative(supported?.max);
  const supportedDistanceKm =
    supportedMin !== null && supportedMax !== null && supportedMin <= supportedMax
      ? { min: supportedMin, max: supportedMax }
      : null;
  const fatigue = ["normal", "above-normal", "unknown"].includes(String(readiness.fatigue))
    ? (String(readiness.fatigue) as CyclingPlanReadinessInput["fatigue"])
    : "unknown";
  const missedKeyWorkouts = Math.max(0, Math.trunc(nonnegative(readiness.missedKeyWorkouts) ?? 0));
  const course = object(readiness.courseEstimate);
  const range = object(course?.rangeMinutes);
  const previous = object(course?.previousRangeMinutes);
  const rangeMin = nonnegative(range?.min);
  const rangeMax = nonnegative(range?.max);
  const previousMin = nonnegative(previous?.min);
  const previousMax = nonnegative(previous?.max);
  const sourceStatus = ["available", "unavailable", "changed"].includes(String(course?.status))
    ? (String(course?.status) as CyclingPlanReadinessInput["courseEstimate"]["status"])
    : "unavailable";
  const assumptions = Array.isArray(course?.assumptions)
    ? course.assumptions.filter(
        (assumption): assumption is string =>
          typeof assumption === "string" && assumption.length > 0,
      )
    : [];
  const confidence = ["low", "moderate", "high"].includes(String(course?.confidence))
    ? (String(course?.confidence) as CyclingPlanReadinessInput["courseEstimate"]["confidence"])
    : null;
  const sourceUnavailableReason = ["missing-course", "missing-elevation"].includes(
    String(course?.unavailableReason),
  )
    ? (String(
        course?.unavailableReason,
      ) as CyclingPlanReadinessInput["courseEstimate"]["unavailableReason"])
    : null;
  const rangeMinutes =
    rangeMin !== null && rangeMax !== null && rangeMin > 0 && rangeMin <= rangeMax
      ? { min: Math.round(rangeMin), max: Math.round(rangeMax) }
      : null;
  const previousRangeMinutes =
    previousMin !== null && previousMax !== null && previousMin > 0 && previousMin <= previousMax
      ? { min: Math.round(previousMin), max: Math.round(previousMax) }
      : null;
  const changedAssumption =
    typeof course?.changedAssumption === "string" && course.changedAssumption.length > 0
      ? course.changedAssumption
      : null;
  const status =
    sourceStatus === "available" && rangeMinutes !== null && confidence !== null
      ? "available"
      : sourceStatus === "changed" &&
          rangeMinutes !== null &&
          previousRangeMinutes !== null &&
          confidence !== null &&
          changedAssumption !== null
        ? "changed"
        : "unavailable";
  const evidence = object(readiness.evidence);
  return {
    supportedDistanceKm,
    missedKeyWorkouts,
    fatigue,
    courseEstimate: {
      status,
      rangeMinutes: status === "unavailable" ? null : rangeMinutes,
      previousRangeMinutes: status === "changed" ? previousRangeMinutes : null,
      confidence: status === "unavailable" ? null : confidence,
      assumptions,
      changedAssumption: status === "changed" ? changedAssumption : null,
      unavailableReason:
        status === "unavailable" ? (sourceUnavailableReason ?? "missing-course") : null,
    },
    evidence: {
      prescribedDurationS: Math.trunc(nonnegative(evidence?.prescribedDurationS) ?? 0),
      riddenDurationS: Math.trunc(nonnegative(evidence?.riddenDurationS) ?? 0),
      adjustedDurationS: Math.trunc(nonnegative(evidence?.adjustedDurationS) ?? 0),
    },
  };
}

export function projectCyclingReadinessInput(
  input: CyclingReadinessSourceInput,
): CyclingPlanReadinessInput {
  return {
    today: input.today,
    raceDate: input.raceDate,
    platformSeed: platformSeed(input.wellness, input.today, input.lastSuccessfulRefreshAtMs),
    dailyLoadRanges: dailyLoadRanges(input.today, input.raceDate, input.workouts),
    estimatedCp: input.estimatedCp,
    ...sourceFacts(input.currentStatus),
  };
}

interface PhaseValue {
  readonly focus: string;
  readonly durationWeeks: number;
}

function phases(structureJson: string): readonly PhaseValue[] | null {
  const value = jsonObject(structureJson)?.phases;
  if (!Array.isArray(value) || value.length === 0) return null;
  const result: PhaseValue[] = [];
  for (const item of value) {
    const phase = object(item);
    const durationWeeks = finite(phase?.durationWeeks);
    if (
      typeof phase?.focus !== "string" ||
      phase.focus.length === 0 ||
      durationWeeks === null ||
      !Number.isInteger(durationWeeks) ||
      durationWeeks <= 0
    ) {
      return null;
    }
    result.push({ focus: phase.focus, durationWeeks });
  }
  return result;
}

function hardIntent(structureJson: string): boolean {
  const value = jsonObject(structureJson);
  const intent = String(value?.intensity ?? value?.workoutType ?? "").toLowerCase();
  return ["hard", "threshold", "vo2", "anaerobic"].includes(intent);
}

function clock(durationS: number | null): string {
  if (durationS === null) return "duration unavailable";
  const hours = Math.floor(durationS / 3_600);
  const minutes = Math.round((durationS % 3_600) / 60);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}`
    : `0:${String(minutes).padStart(2, "0")}`;
}

export function cyclingTaperRefusal(input: {
  readonly planStructureJson: string;
  readonly planStartDate: string;
  readonly planTotalWeeks: number;
  readonly workoutDate: string;
  readonly current: { readonly name: string; readonly durationS: number | null };
  readonly next: {
    readonly name: string;
    readonly durationS: number | null;
    readonly structureJson: string;
  };
}): { readonly requested: string; readonly kept: string } | null {
  const values = phases(input.planStructureJson);
  if (
    values === null ||
    values.reduce((sum, value) => sum + value.durationWeeks, 0) !== input.planTotalWeeks
  ) {
    return null;
  }
  const taperIndex = values.findIndex((value) => value.focus.toLowerCase() === "taper");
  if (taperIndex === -1) return null;
  const weeksBefore = values
    .slice(0, taperIndex)
    .reduce((sum, value) => sum + value.durationWeeks, 0);
  const taperStart = addDays(input.planStartDate, weeksBefore * 7);
  const planEnd = addDays(input.planStartDate, input.planTotalWeeks * 7 - 1);
  if (input.workoutDate < taperStart || input.workoutDate > planEnd) return null;
  const durationIncrease =
    input.current.durationS !== null &&
    input.next.durationS !== null &&
    input.next.durationS > input.current.durationS;
  if (!durationIncrease && !hardIntent(input.next.structureJson)) return null;
  return {
    requested: `${input.next.name} · ${clock(input.next.durationS)}`,
    kept: `${input.current.name} · ${clock(input.current.durationS)}`,
  };
}
