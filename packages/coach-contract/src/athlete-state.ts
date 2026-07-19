import { z } from "zod";

export const FreshnessSchema = z.enum(["fresh", "flag", "stale", "critical"]);
export type Freshness = z.infer<typeof FreshnessSchema>;

export const TrainingContextUnknownReasonSchema = z.enum([
  "not-synced",
  "missing-anchor",
  "no-platform-load",
  "no-plan",
  "insufficient-data",
  "no-wellness",
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
      reason: z.enum(["not-synced", "no-platform-load"]),
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
      reason: z.enum(["not-synced", "no-plan", "insufficient-data"]),
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

export const CyclingTrainingContextSchema = z
  .object({
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
export type CyclingTrainingContext = z.infer<typeof CyclingTrainingContextSchema>;

export const UNKNOWN_CYCLING_TRAINING_CONTEXT: CyclingTrainingContext = {
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
 * was rejected with a blocking mitigation posture; `lastSynced` is the
 * last-successful-sync anchor (falls back to the failure timestamp when the
 * cache is unavailable) and is null only when neither exists.
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
