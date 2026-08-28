import {
  PlanReadinessProjectionSchema,
  type PlanReadinessProjection,
} from "@enduragent/coach-contract";

export interface PlanReadinessInput {
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
  readonly estimatedCp: PlanReadinessProjection["estimatedCp"];
  readonly evidence: {
    readonly prescribedDurationS: number;
    readonly riddenDurationS: number;
    readonly adjustedDurationS: number;
  };
}

export interface ProjectedPlanReadiness {
  readonly scenarioId: "PL-S012" | "PL-S074" | "PL-S075" | "PL-S076" | "PL-S077";
  readonly projection: PlanReadinessProjection;
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

function finiteNonnegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function orderedRange(min: number, max: number): { readonly min: number; readonly max: number } {
  return min <= max ? { min, max } : { min: max, max: min };
}

function unavailableForm(
  input: PlanReadinessInput,
  reason: "missing-platform-seed" | "missing-planned-load" | "refresh-failed",
): PlanReadinessProjection["form"] {
  return {
    status: "unavailable",
    asOf: input.platformSeed?.asOf ?? null,
    current:
      input.platformSeed === null
        ? null
        : Math.round(input.platformSeed.fitness - input.platformSeed.fatigue),
    raceRange: null,
    assumptions: [],
    unavailableReason: reason,
    lastSuccessfulRefreshAtMs: input.platformSeed?.lastSuccessfulRefreshAtMs ?? null,
  };
}

function projectForm(input: PlanReadinessInput): PlanReadinessProjection["form"] {
  if (input.platformSeed === null || input.raceDate === null) {
    return unavailableForm(input, "missing-platform-seed");
  }
  const loads = new Map(input.dailyLoadRanges.map((value) => [value.date, value]));
  let lowFitness = input.platformSeed.fitness;
  let lowFatigue = input.platformSeed.fatigue;
  let highFitness = input.platformSeed.fitness;
  let highFatigue = input.platformSeed.fatigue;
  for (let date = addDays(input.today, 1); date <= input.raceDate; date = addDays(date, 1)) {
    const range = loads.get(date);
    if (
      range === undefined ||
      !finiteNonnegative(range.min) ||
      !finiteNonnegative(range.max) ||
      range.min > range.max
    ) {
      return unavailableForm(input, "missing-planned-load");
    }
    lowFitness += (range.min - lowFitness) / 42;
    lowFatigue += (range.min - lowFatigue) / 7;
    highFitness += (range.max - highFitness) / 42;
    highFatigue += (range.max - highFatigue) / 7;
  }
  const range = orderedRange(
    Math.round(lowFitness - lowFatigue),
    Math.round(highFitness - highFatigue),
  );
  return {
    status: "available",
    asOf: input.platformSeed.asOf,
    current: Math.round(input.platformSeed.fitness - input.platformSeed.fatigue),
    raceRange: range,
    assumptions: ["Planned training", "Normal recovery"],
    unavailableReason: null,
    lastSuccessfulRefreshAtMs: input.platformSeed.lastSuccessfulRefreshAtMs,
  };
}

function projectFeasibility(
  input: PlanReadinessInput,
  form: PlanReadinessProjection["form"],
): PlanReadinessProjection["feasibility"] {
  const negativeRange = form.raceRange !== null && form.raceRange.max < 0;
  const evidenceRisk = input.fatigue === "above-normal" && input.missedKeyWorkouts >= 2;
  const atRisk = negativeRange || evidenceRisk;
  const reasons = atRisk
    ? [
        ...(input.fatigue === "above-normal" ? ["Fatigue is above normal"] : []),
        ...(input.missedKeyWorkouts >= 2
          ? [`${input.missedKeyWorkouts} key Workouts were missed`]
          : []),
        ...(negativeRange ? ["The modeled race-day Form range remains negative"] : []),
      ]
    : ["The modeled range supports the current goal under the stated assumptions"];
  return {
    verdict: atRisk ? "at-risk" : "on-track",
    supportedDistanceKm: input.supportedDistanceKm,
    reasons,
    recommendation: atRisk ? "Protect recovery this week" : "Continue the approved Plan",
  };
}

function scenarioFor(projection: PlanReadinessProjection): ProjectedPlanReadiness["scenarioId"] {
  if (projection.form.status === "unavailable") return "PL-S076";
  if (projection.courseEstimate.status === "changed") return "PL-S077";
  if (projection.feasibility.verdict === "at-risk") return "PL-S074";
  if (projection.courseEstimate.status === "unavailable") return "PL-S075";
  return "PL-S012";
}

export function projectPlanReadiness(input: PlanReadinessInput): ProjectedPlanReadiness {
  const form = projectForm(input);
  const projection = PlanReadinessProjectionSchema.parse({
    form,
    feasibility: projectFeasibility(input, form),
    courseEstimate: input.courseEstimate,
    estimatedCp: input.estimatedCp,
    evidence: {
      ...input.evidence,
      missedKeyWorkouts: input.missedKeyWorkouts,
      fatigue: input.fatigue,
    },
    taperRefusal: null,
    error: null,
  });
  return { scenarioId: scenarioFor(projection), projection };
}

export function refreshingPlanReadiness(
  previous: PlanReadinessProjection,
): PlanReadinessProjection {
  return PlanReadinessProjectionSchema.parse({
    ...previous,
    form: { ...previous.form, status: "refreshing", unavailableReason: null },
    error: null,
  });
}

export function failedPlanReadiness(
  previous: PlanReadinessProjection,
  message = "Recent training load could not be refreshed from Intervals.",
): PlanReadinessProjection {
  return PlanReadinessProjectionSchema.parse({
    ...previous,
    form: {
      ...previous.form,
      status: "unavailable",
      raceRange: null,
      unavailableReason: "refresh-failed",
    },
    error: { code: "provider-failed", message, retryable: true },
  });
}

export function taperRefusalReadiness(
  previous: PlanReadinessProjection,
  input: { readonly requested: string; readonly kept: string },
): PlanReadinessProjection {
  return PlanReadinessProjectionSchema.parse({
    ...previous,
    taperRefusal: {
      requested: input.requested,
      kept: input.kept,
      reason: "Adding missed work during taper would reduce freshness before the race.",
    },
    error: null,
  });
}
