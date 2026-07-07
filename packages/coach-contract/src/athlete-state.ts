import { z } from "zod";

export const FreshnessSchema = z.enum(["fresh", "flag", "stale", "critical"]);
export type Freshness = z.infer<typeof FreshnessSchema>;

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
  })
  .strict();
export type AthleteState = z.infer<typeof AthleteStateSchema>;
