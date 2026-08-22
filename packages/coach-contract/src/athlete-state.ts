import { z } from "zod";

export const FreshnessSchema = z.enum(["fresh", "flag", "stale", "critical"]);
export type Freshness = z.infer<typeof FreshnessSchema>;

const POWER_PROGRESS_DURATIONS = [5, 60, 300, 1_200, 3_600] as const;
const POWER_PROGRESS_HR_DURATIONS = [60, 300, 1_200, 3_600] as const;

function isCivilDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function civilEpochDay(value: string): number {
  return Date.parse(`${value}T00:00:00.000Z`) / 86_400_000;
}

const PowerProgressDateSchema = z.string().length(10).refine(isCivilDate, "invalid civil date");

const CivilDateWindowSchema = z
  .object({
    start: PowerProgressDateSchema,
    end: PowerProgressDateSchema,
  })
  .strict()
  .refine((value) => value.start <= value.end, "date window start must not follow its end");

export const PowerProgressDateWindowSchema = CivilDateWindowSchema.refine(
  (value) => civilEpochDay(value.end) - civilEpochDay(value.start) === 27,
  {
    message: "power progress window must contain 28 days",
  },
);

const PowerProgressSustainabilityWindowSchema = CivilDateWindowSchema.refine(
  (value) => civilEpochDay(value.end) - civilEpochDay(value.start) === 41,
  { message: "sustainability window must contain 42 days" },
);

const ProgressUnavailableValueSchema = z.object({ kind: z.literal("unavailable") }).strict();

export const PowerProgressWattsSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("computed"),
      watts: z.number().finite().positive().max(20_000),
    })
    .strict(),
  ProgressUnavailableValueSchema,
]);

export const PowerProgressBpmSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("computed"),
      bpm: z.number().finite().positive().max(500),
    })
    .strict(),
  ProgressUnavailableValueSchema,
]);

export const PowerProgressChangeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("computed"),
      percent: z.number().finite().min(-1_000_000).max(1_000_000),
    })
    .strict(),
  ProgressUnavailableValueSchema,
]);

function changeMatchesValues(value: {
  readonly current: { readonly kind: "computed" | "unavailable" };
  readonly previous: { readonly kind: "computed" | "unavailable" };
  readonly change: { readonly kind: "computed" | "unavailable" };
}): boolean {
  const comparable = value.current.kind === "computed" && value.previous.kind === "computed";
  return comparable === (value.change.kind === "computed");
}

export const PowerProgressAnchorSchema = z
  .object({
    durationSeconds: z.union(POWER_PROGRESS_DURATIONS.map((value) => z.literal(value))),
    current: PowerProgressWattsSchema,
    previous: PowerProgressWattsSchema,
    change: PowerProgressChangeSchema,
  })
  .strict()
  .refine(changeMatchesValues, "power progress change requires both window values");

export const PowerProgressHeartRateAnchorSchema = z
  .object({
    durationSeconds: z.union(POWER_PROGRESS_HR_DURATIONS.map((value) => z.literal(value))),
    current: PowerProgressBpmSchema,
    previous: PowerProgressBpmSchema,
    change: PowerProgressChangeSchema,
  })
  .strict()
  .refine(changeMatchesValues, "heart-rate change requires both window values");

function exactDurations(
  values: readonly { readonly durationSeconds: number }[],
  expected: readonly number[],
): boolean {
  return (
    values.length === expected.length &&
    values.every((value, index) => value.durationSeconds === expected[index])
  );
}

const PowerProgressAnchorsSchema = z
  .array(PowerProgressAnchorSchema)
  .length(POWER_PROGRESS_DURATIONS.length)
  .refine((value) => exactDurations(value, POWER_PROGRESS_DURATIONS), "unexpected power anchors");

const PowerProgressHeartRateContextSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("computed"),
      anchors: z
        .array(PowerProgressHeartRateAnchorSchema)
        .length(POWER_PROGRESS_HR_DURATIONS.length)
        .refine(
          (value) => exactDurations(value, POWER_PROGRESS_HR_DURATIONS),
          "unexpected heart-rate anchors",
        ),
    })
    .strict(),
  z
    .object({
      kind: z.literal("unavailable"),
      reason: z.literal("insufficient-data"),
    })
    .strict(),
]);

const PowerProgressSustainabilityContextSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("computed"),
      window: PowerProgressSustainabilityWindowSchema,
      coverageRatio: z.number().finite().min(0).max(1),
      sourceContext: z.enum(["indoor", "outdoor", "mixed", "unknown"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("unavailable"),
      reason: z.literal("insufficient-data"),
    })
    .strict(),
]);

export const PowerProgressRefreshFailureCodeSchema = z.enum([
  "request-budget-exhausted",
  "rate-limited",
  "timeout",
  "network",
  "provider-unavailable",
  "malformed-response",
  "response-too-large",
  "cancelled",
  "temporary-failure",
]);

export const PowerProgressRefreshFailureSchema = z
  .object({
    code: PowerProgressRefreshFailureCodeSchema,
    failedAt: z.string().max(64).datetime({ offset: true }),
  })
  .strict();

export const PowerProgressUnavailableReasonSchema = z.enum([
  "not-synced",
  "insufficient-data",
  "invalid-data",
  "refresh-failed",
  "temporary-failure",
  "source-restricted",
]);

export const PowerProgressComputedSchema = z
  .object({
    kind: z.literal("computed"),
    currentWindow: PowerProgressDateWindowSchema,
    previousWindow: PowerProgressDateWindowSchema,
    anchors: PowerProgressAnchorsSchema,
    rotation: z.enum(["sprint", "endurance", "balanced", "unknown"]),
    heartRateContext: PowerProgressHeartRateContextSchema,
    sustainabilityContext: PowerProgressSustainabilityContextSchema,
    freshness: FreshnessSchema,
    asOf: z.string().max(64).datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, context) => {
    if (civilEpochDay(value.currentWindow.start) - civilEpochDay(value.previousWindow.end) !== 1) {
      context.addIssue({
        code: "custom",
        path: ["previousWindow"],
        message: "power progress windows must be adjacent",
      });
    }
    if (
      value.sustainabilityContext.kind === "computed" &&
      (value.sustainabilityContext.window.end !== value.currentWindow.end ||
        civilEpochDay(value.sustainabilityContext.window.end) -
          civilEpochDay(value.sustainabilityContext.window.start) !==
          41)
    ) {
      context.addIssue({
        code: "custom",
        path: ["sustainabilityContext", "window"],
        message: "sustainability window must be the matching 42-day window",
      });
    }
  });

export const PowerProgressPanelSchema = z.discriminatedUnion("kind", [
  PowerProgressComputedSchema,
  z
    .object({
      kind: z.literal("unavailable"),
      reason: PowerProgressUnavailableReasonSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("stale"),
      lastGood: PowerProgressComputedSchema,
      refreshFailure: PowerProgressRefreshFailureSchema,
    })
    .strict(),
]);

export type PowerProgressDateWindow = z.infer<typeof PowerProgressDateWindowSchema>;
export type PowerProgressWatts = z.infer<typeof PowerProgressWattsSchema>;
export type PowerProgressBpm = z.infer<typeof PowerProgressBpmSchema>;
export type PowerProgressChange = z.infer<typeof PowerProgressChangeSchema>;
export type PowerProgressAnchor = z.infer<typeof PowerProgressAnchorSchema>;
export type PowerProgressHeartRateAnchor = z.infer<typeof PowerProgressHeartRateAnchorSchema>;
export type PowerProgressRefreshFailureCode = z.infer<typeof PowerProgressRefreshFailureCodeSchema>;
export type PowerProgressRefreshFailure = z.infer<typeof PowerProgressRefreshFailureSchema>;
export type PowerProgressUnavailableReason = z.infer<typeof PowerProgressUnavailableReasonSchema>;
export type PowerProgressComputed = z.infer<typeof PowerProgressComputedSchema>;
export type PowerProgressPanel = z.infer<typeof PowerProgressPanelSchema>;

export const TrainingContextUnknownReasonSchema = z.enum([
  "not-synced",
  "missing-anchor",
  "no-platform-load",
  "no-plan",
  "insufficient-data",
  "no-wellness",
  "source-restricted",
]);

export const CyclingAnchorSchema = z
  .object({
    watts: z.number().positive(),
    validFrom: z.string().min(1),
    source: z.string().min(1),
    confidence: z.enum(["manual", "platform", "fit"]),
    ageDays: z.number().nonnegative(),
    stalenessBand: z.enum(["fresh", "aging", "stale", "very-stale"]),
    stale: z.boolean(),
  })
  .strict();

export const CyclingZoneRowSchema = z
  .object({
    name: z.string().min(1),
    range: z.string().min(1),
    overlaps: z.boolean(),
  })
  .strict();

export const AnchorZonesPanelSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("computed"),
      asOf: z.string().min(1),
      anchor: CyclingAnchorSchema,
      zones: z.array(CyclingZoneRowSchema).length(6),
    })
    .strict(),
  z
    .object({
      kind: z.literal("unknown"),
      reason: z.enum(["not-synced", "missing-anchor"]),
    })
    .strict(),
]);

export const CyclingLoadPanelSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("computed"),
      asOf: z.string().min(1),
      source: z.literal("intervals.icu"),
      windowDays: z.literal(7),
      value: z.number().nonnegative(),
      activityCount: z.number().int().nonnegative(),
      missingLoadCount: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("unknown"),
      reason: z.enum(["not-synced", "no-platform-load", "source-restricted"]),
    })
    .strict(),
]);

export const PlanItemSchema = z
  .object({
    id: z.string().min(1),
    date: z.string().min(1),
    name: z.string().nullable(),
    category: z.string().min(1),
    workoutType: z.string().min(1),
  })
  .strict();

export const PlanPanelSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("computed"),
      asOf: z.string().min(1),
      items: z.array(PlanItemSchema).max(7),
    })
    .strict(),
  z.object({ kind: z.literal("unknown"), reason: z.enum(["not-synced", "no-plan"]) }).strict(),
]);

export const AdherencePanelSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("computed"),
      asOf: z.string().min(1),
      ratio: z.number().min(0).max(1),
      plannedDays: z.number().int().nonnegative(),
      completedDays: z.number().int().nonnegative(),
      matchedDays: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("unknown"),
      reason: z.enum(["not-synced", "no-plan", "insufficient-data", "source-restricted"]),
    })
    .strict(),
]);

export const WellnessPointSchema = z
  .object({ date: z.string().min(1), value: z.number() })
  .strict();

export const WellnessSeriesSchema = z
  .object({
    metric: z.enum(["hrv", "sleep", "resting-hr"]),
    unit: z.enum(["ms", "seconds", "bpm"]),
    points: z.array(WellnessPointSchema).max(7),
  })
  .strict();

export const WellnessTrendPanelSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("computed"),
      asOf: z.string().min(1),
      windowDays: z.literal(7),
      series: z.array(WellnessSeriesSchema).length(3),
    })
    .strict(),
  z
    .object({
      kind: z.literal("unknown"),
      reason: z.enum(["not-synced", "no-wellness", "insufficient-data"]),
    })
    .strict(),
]);

export const RecentRideSchema = z
  .object({
    id: z.string().regex(/^[0-9a-f]{64}$/u),
    subSport: z.string().min(1).max(128).nullable(),
    startEpochSeconds: z.number().int().safe().nonnegative(),
    timezoneOffsetSeconds: z.number().int().min(-86_400).max(86_400).nullable(),
    localDate: PowerProgressDateSchema,
    elapsedSeconds: z.number().int().safe().nonnegative().nullable(),
    movingSeconds: z.number().int().safe().nonnegative().nullable(),
    distanceMeters: z.number().finite().nonnegative().max(100_000_000).nullable(),
  })
  .strict();

export const RecentRidesPanelSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("computed"),
      asOf: z.string().min(1).max(64),
      windowDays: z.literal(28),
      items: z.array(RecentRideSchema).min(1).max(8),
    })
    .strict(),
  z
    .object({
      kind: z.literal("unknown"),
      reason: z.enum(["not-synced", "no-recent-rides", "temporary-failure", "source-restricted"]),
    })
    .strict(),
]);

export const CyclingTrainingContextSchema = z
  .object({
    performanceProgress: PowerProgressPanelSchema,
    recentRides: RecentRidesPanelSchema.default({ kind: "unknown", reason: "not-synced" }),
    anchorZones: AnchorZonesPanelSchema,
    cyclingLoad: CyclingLoadPanelSchema,
    plan: PlanPanelSchema,
    adherence: AdherencePanelSchema,
    wellnessTrend: WellnessTrendPanelSchema,
  })
  .strict();

export type TrainingContextUnknownReason = z.infer<typeof TrainingContextUnknownReasonSchema>;
export type CyclingAnchor = z.infer<typeof CyclingAnchorSchema>;
export type CyclingZoneRow = z.infer<typeof CyclingZoneRowSchema>;
export type AnchorZonesPanel = z.infer<typeof AnchorZonesPanelSchema>;
export type CyclingLoadPanel = z.infer<typeof CyclingLoadPanelSchema>;
export type PlanItem = z.infer<typeof PlanItemSchema>;
export type PlanPanel = z.infer<typeof PlanPanelSchema>;
export type AdherencePanel = z.infer<typeof AdherencePanelSchema>;
export type WellnessPoint = z.infer<typeof WellnessPointSchema>;
export type WellnessSeries = z.infer<typeof WellnessSeriesSchema>;
export type WellnessTrendPanel = z.infer<typeof WellnessTrendPanelSchema>;
export type RecentRide = z.infer<typeof RecentRideSchema>;
export type RecentRidesPanel = z.infer<typeof RecentRidesPanelSchema>;
export type CyclingTrainingContext = z.infer<typeof CyclingTrainingContextSchema>;

export const UNKNOWN_CYCLING_TRAINING_CONTEXT: CyclingTrainingContext = {
  performanceProgress: { kind: "unavailable", reason: "not-synced" },
  recentRides: { kind: "unknown", reason: "not-synced" },
  anchorZones: { kind: "unknown", reason: "not-synced" },
  cyclingLoad: { kind: "unknown", reason: "not-synced" },
  plan: { kind: "unknown", reason: "not-synced" },
  adherence: { kind: "unknown", reason: "not-synced" },
  wellnessTrend: { kind: "unknown", reason: "not-synced" },
};

export const AthleteDerivedMetricsSchema = z
  .object({
    // Fenced from surface rendering: raw workload-ratio value must not
    // reach a rendering surface. Present key => parse failure.
    acwr: z.never().optional(),
    monotony: z.number().nullable().optional(),
    primary_sport_monotony: z.number().nullable().optional(),
    effective_monotony: z.number().nullable().optional(),
    monotony_interpretation: z.string().nullable().optional(),
    multi_sport_detected: z.unknown().nullable().optional(),
    strain: z.number().nullable().optional(),
    recovery_index: z.number().nullable().optional(),
    stress_tolerance: z.number().nullable().optional(),
    load_recovery_ratio: z.number().nullable().optional(),
    zone_distribution_7d: z.unknown().nullable().optional(),
    grey_zone_percentage: z.number().nullable().optional(),
    grey_zone_note: z.string().nullable().optional(),
    quality_intensity_percentage: z.number().nullable().optional(),
    quality_intensity_note: z.string().nullable().optional(),
    easy_time_ratio: z.number().nullable().optional(),
    easy_time_ratio_note: z.string().nullable().optional(),
    seiler_tid_7d: z.unknown().nullable().optional(),
    seiler_tid_7d_primary: z.unknown().nullable().optional(),
    seiler_tid_28d: z.unknown().nullable().optional(),
    seiler_tid_28d_primary: z.unknown().nullable().optional(),
    consistency_index: z.number().nullable().optional(),
    consistency_details: z.unknown().nullable().optional(),
    seasonal_context: z.unknown().nullable().optional(),
    benchmark_indoor: z.unknown().nullable().optional(),
    benchmark_outdoor: z.unknown().nullable().optional(),
    has_intervals: z.unknown().nullable().optional(),
    effort_response_signal: z.unknown().nullable().optional(),
    weight_signal: z.unknown().nullable().optional(),
    "capability.durability": z.unknown().nullable().optional(),
    "capability.efficiency_factor": z.unknown().nullable().optional(),
    "capability.hrrc": z.unknown().nullable().optional(),
    "capability.tid_comparison": z.unknown().nullable().optional(),
    "capability.power_curve_delta": z.unknown().nullable().optional(),
    "capability.hr_curve_delta": z.unknown().nullable().optional(),
    "capability.sustainability_profile": z.unknown().nullable().optional(),
    // Fenced from surface rendering: the running heart-beat-interval
    // profile must not reach a rendering surface. Present key => parse failure.
    "capability.dfa_a1_profile": z.never().optional(),
    eftp: z.number().nullable().optional(),
    w_prime: z.number().nullable().optional(),
    w_prime_kj: z.number().nullable().optional(),
    p_max: z.number().nullable().optional(),
    power_model_source: z.string().nullable().optional(),
    vo2max: z.number().nullable().optional(),
  })
  .passthrough();

/**
 * Deterministic athlete-status DTO, derived from the persisted latest-data
 * model — never from a chat turn's free text. `degraded` means the last sync
 * was rejected with a blocking mitigation posture. `lastUpdated` is the latest
 * persisted data-mutation timestamp; `lastSynced` is exclusively the validated
 * `.scheduler.json:last_sync_at` commit marker for the last successful Reference
 * sync, or null when that marker is absent or invalid.
 */
export const AthleteStateSchema = z
  .object({
    schemaVersion: z.string(),
    lastUpdated: z.string(),
    freshness: FreshnessSchema,
    degraded: z.boolean(),
    lastSynced: z.string().nullable(),
    athleteProfile: z.unknown(),
    currentStatus: z.unknown(),
    derivedMetrics: AthleteDerivedMetricsSchema,
    derivedMetricsMeta: z
      .object({
        sportFamily: z.string(),
        prescriptionBasis: z.enum(["power", "pace"]),
        anchorType: z.enum(["critical-speed", "ftp"]),
        analysisBasis: z.enum(["power", "hr", "mixed"]).nullable(),
      })
      .strict()
      .optional(),
    recentActivities: z.array(z.unknown()),
    plannedWorkouts: z.array(z.unknown()),
    wellness: z.unknown(),
    trainingContext: CyclingTrainingContextSchema.optional(),
  })
  .strict();
export type AthleteState = z.infer<typeof AthleteStateSchema>;
