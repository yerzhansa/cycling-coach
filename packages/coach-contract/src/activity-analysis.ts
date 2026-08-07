import { z } from "zod";

export const ACTIVITY_ANALYSIS_SCHEMA_VERSION = 1 as const;
export const MAX_ACTIVITY_ANALYSIS_RESPONSE_BYTES = 512 * 1_024;
export const MAX_ACTIVITY_ANALYSIS_INTERVALS = 200;
export const MAX_ACTIVITY_ANALYSIS_INTERVAL_GROUPS = 50;
export const MAX_ACTIVITY_ANALYSIS_EFFORTS = 10;
export const MAX_ACTIVITY_ANALYSIS_BUCKETS = 256;
export const MAX_ACTIVITY_ANALYSIS_POWER_HEART_RATE_ROWS = 256;
export const MAX_ACTIVITY_ANALYSIS_POWER_HEART_RATE_CURVES = 8;

export const ACTIVITY_ANALYSIS_SECTIONS = [
  "aerobic-drift",
  "intervals",
  "best-efforts",
  "power-distribution",
  "heart-rate-distribution",
  "power-heart-rate",
] as const;

export const ActivityAnalysisSectionSchema = z.enum(ACTIVITY_ANALYSIS_SECTIONS);
export const CanonicalActivityIdSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const ActivityAnalysisRevisionSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const ActivityAnalysisRequestSchema = z
  .object({
    canonicalActivityId: CanonicalActivityIdSchema,
    sections: z.array(ActivityAnalysisSectionSchema).min(1).max(ACTIVITY_ANALYSIS_SECTIONS.length),
    refresh: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.sections).size !== value.sections.length) {
      context.addIssue({
        code: "custom",
        path: ["sections"],
        message: "analysis sections must be unique",
      });
    }
  });

function isCivilDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function isSafeDisplayText(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint <= 31
      || (codePoint >= 127 && codePoint <= 159)
      || codePoint === 0x2028
      || codePoint === 0x2029
      || (codePoint >= 0x202a && codePoint <= 0x202e)
      || (codePoint >= 0x2066 && codePoint <= 0x2069)
    ) {
      return false;
    }
  }
  return true;
}

const boundedDisplayText = (maximum: number) => z.string().min(1).max(maximum)
  .refine(isSafeDisplayText, "unsafe display text");

const SafeIntegerSchema = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const NonnegativeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const NullableDurationSchema = NonnegativeIntegerSchema.nullable();
const NonnegativeFiniteSchema = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);
const NullableNonnegativeFiniteSchema = NonnegativeFiniteSchema.nullable();
const NullableNonnegativeIntegerSchema = NonnegativeIntegerSchema.nullable();

export const CanonicalActivitySummarySchema = z
  .object({
    id: CanonicalActivityIdSchema,
    workoutId: CanonicalActivityIdSchema,
    sessionSequence: NonnegativeIntegerSchema,
    isMultisport: z.boolean(),
    sport: boundedDisplayText(64),
    subSport: boundedDisplayText(128).nullable(),
    isTransition: z.boolean(),
    startEpochSeconds: SafeIntegerSchema,
    timezoneOffsetSeconds: z.number().int().min(-86_400).max(86_400).nullable(),
    localDate: z.string().refine(isCivilDate, "invalid civil date"),
    elapsedSeconds: NullableDurationSchema,
    timerSeconds: NullableDurationSchema,
    movingSeconds: NullableDurationSchema,
    distanceMeters: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  })
  .strict();

const OffsetInstantSchema = z.string().max(64).datetime({ offset: true });

export const AnalysisProvenanceSchema = z
  .object({
    source: z.enum(["local-canonical", "provider"]),
    delivery: z.enum(["live", "persisted-cache"]),
    observedAt: OffsetInstantSchema,
  })
  .strict();

export const AnalysisUnavailableReasonSchema = z.enum([
  "activity-not-found",
  "source-not-found",
  "ambiguous-source",
  "not-provider-backed",
  "missing-sensor-data",
  "duplicate-stream",
  "misaligned-stream",
  "invalid-timestamps",
  "activity-too-short",
  "insufficient-coverage",
  "unstable-output",
  "moving-status-unavailable",
  "unsuitable-activity",
  "empty-response",
  "malformed-response",
  "response-too-large",
  "request-budget-exhausted",
  "rate-limited",
  "timeout",
  "network",
  "provider-unavailable",
  "cancelled",
  "unsupported",
  "temporary-failure",
]);

export const AnalysisRefreshFailureCodeSchema = z.enum([
  "request-budget-exhausted",
  "rate-limited",
  "timeout",
  "network",
  "provider-unavailable",
  "malformed-response",
  "response-too-large",
  "cancelled",
  "source-changed",
  "temporary-failure",
]);

export const AnalysisRefreshFailureSchema = z
  .object({
    code: AnalysisRefreshFailureCodeSchema,
    failedAt: OffsetInstantSchema,
  })
  .strict();

export function createAnalysisSectionSchema<T extends z.ZodType>(data: T) {
  const computed = z
    .object({
      kind: z.literal("computed"),
      data,
      provenance: AnalysisProvenanceSchema,
    })
    .strict();
  return z.discriminatedUnion("kind", [
    computed,
    z
      .object({
        kind: z.literal("unavailable"),
        reason: AnalysisUnavailableReasonSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("stale"),
        lastGood: computed,
        refreshFailure: AnalysisRefreshFailureSchema,
      })
      .strict(),
  ]).superRefine((value, context) => {
    if (
      value.kind === "stale"
      && "lastGood" in value
      && value.lastGood.provenance.delivery !== "persisted-cache"
    ) {
      context.addIssue({
        code: "custom",
        path: ["lastGood", "provenance", "delivery"],
        message: "stale last-good analysis must come from persisted cache",
      });
    }
  });
}

const AerobicDriftHalfSchema = z
  .object({
    durationSeconds: NonnegativeFiniteSchema.max(7 * 86_400),
    sampleCount: NonnegativeIntegerSchema.max(1_000_000),
    averagePowerWatts: NonnegativeFiniteSchema.max(100_000),
    averageHeartRateBpm: NonnegativeFiniteSchema.max(400),
    efficiencyFactor: NonnegativeFiniteSchema.max(100_000),
  })
  .strict();

const AerobicDriftCoverageSchema = z
  .object({
    totalSamples: NonnegativeIntegerSchema.max(1_000_000),
    validSamples: NonnegativeIntegerSchema.max(1_000_000),
    includedDurationSeconds: NonnegativeFiniteSchema.max(7 * 86_400),
    windowDurationSeconds: NonnegativeFiniteSchema.max(7 * 86_400),
    fraction: z.number().finite().min(0).max(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.validSamples > value.totalSamples) {
      context.addIssue({ code: "custom", path: ["validSamples"], message: "valid samples exceed total" });
    }
    if (value.includedDurationSeconds > value.windowDurationSeconds) {
      context.addIssue({
        code: "custom",
        path: ["includedDurationSeconds"],
        message: "included duration exceeds window",
      });
    }
  });

export const AerobicDriftDataSchema = z
  .object({
    method: z.literal("local-time-weighted-efficiency-factor"),
    firstHalf: AerobicDriftHalfSchema,
    secondHalf: AerobicDriftHalfSchema,
    decouplingPercent: z.number().finite().min(-1_000).max(1_000),
    coverage: AerobicDriftCoverageSchema,
    evidence: z.enum(["standard", "limited"]),
    limitations: z
      .array(z.enum(["duration-under-60-minutes", "variable-output", "moving-status-unavailable"]))
      .max(3)
      .refine((value) => new Set(value).size === value.length, "limitations must be unique"),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.evidence === "standard") !== (value.limitations.length === 0)) {
      context.addIssue({
        code: "custom",
        path: ["limitations"],
        message: "limited evidence requires at least one limitation",
      });
    }
  });

const IntervalKindSchema = z.enum(["work", "recovery", "lap", "unknown"]);
const NullableDisplayTextSchema = boundedDisplayText(128).nullable();

export const ActivityIntervalSchema = z
  .object({
    ordinal: z.number().int().min(1).max(MAX_ACTIVITY_ANALYSIS_INTERVALS),
    groupOrdinal: z.number().int().min(1).max(MAX_ACTIVITY_ANALYSIS_INTERVAL_GROUPS).nullable(),
    kind: IntervalKindSchema,
    label: NullableDisplayTextSchema,
    startIndex: NullableNonnegativeIntegerSchema,
    endIndex: NullableNonnegativeIntegerSchema,
    startSeconds: NullableNonnegativeFiniteSchema,
    endSeconds: NullableNonnegativeFiniteSchema,
    movingSeconds: NullableNonnegativeFiniteSchema,
    elapsedSeconds: NullableNonnegativeFiniteSchema,
    distanceMeters: NullableNonnegativeFiniteSchema,
    averagePowerWatts: NullableNonnegativeFiniteSchema,
    maximumPowerWatts: NullableNonnegativeFiniteSchema,
    averageHeartRateBpm: NullableNonnegativeFiniteSchema,
    maximumHeartRateBpm: NullableNonnegativeFiniteSchema,
    averageCadenceRpm: NullableNonnegativeFiniteSchema,
    maximumCadenceRpm: NullableNonnegativeFiniteSchema,
    zone: z.number().int().min(0).max(100).nullable(),
    intensityPercent: z.number().finite().min(0).max(10_000).nullable(),
    trainingLoad: NullableNonnegativeFiniteSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.startIndex !== null && value.endIndex !== null && value.startIndex > value.endIndex) {
      context.addIssue({ code: "custom", path: ["endIndex"], message: "interval indexes are reversed" });
    }
    if (value.startSeconds !== null && value.endSeconds !== null && value.startSeconds > value.endSeconds) {
      context.addIssue({ code: "custom", path: ["endSeconds"], message: "interval times are reversed" });
    }
  });

export const ActivityIntervalGroupSchema = z
  .object({
    ordinal: z.number().int().min(1).max(MAX_ACTIVITY_ANALYSIS_INTERVAL_GROUPS),
    intervalOrdinals: z
      .array(z.number().int().min(1).max(MAX_ACTIVITY_ANALYSIS_INTERVALS))
      .min(1)
      .max(MAX_ACTIVITY_ANALYSIS_INTERVALS)
      .refine((value) => new Set(value).size === value.length, "interval ordinals must be unique"),
    kind: IntervalKindSchema,
    movingSeconds: NullableNonnegativeFiniteSchema,
    elapsedSeconds: NullableNonnegativeFiniteSchema,
    averagePowerWatts: NullableNonnegativeFiniteSchema,
    maximumPowerWatts: NullableNonnegativeFiniteSchema,
    averageHeartRateBpm: NullableNonnegativeFiniteSchema,
    maximumHeartRateBpm: NullableNonnegativeFiniteSchema,
    averageCadenceRpm: NullableNonnegativeFiniteSchema,
    maximumCadenceRpm: NullableNonnegativeFiniteSchema,
    zone: z.number().int().min(0).max(100).nullable(),
    intensityPercent: z.number().finite().min(0).max(10_000).nullable(),
    trainingLoad: NullableNonnegativeFiniteSchema,
  })
  .strict();

export const IntervalReviewDataSchema = z
  .object({
    source: z.enum(["local-canonical", "provider"]),
    intervals: z.array(ActivityIntervalSchema).max(MAX_ACTIVITY_ANALYSIS_INTERVALS),
    groups: z.array(ActivityIntervalGroupSchema).max(MAX_ACTIVITY_ANALYSIS_INTERVAL_GROUPS),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.intervals.some((interval, index) => interval.ordinal !== index + 1)) {
      context.addIssue({ code: "custom", path: ["intervals"], message: "interval ordinals are not contiguous" });
    }
    if (value.groups.some((group, index) => group.ordinal !== index + 1)) {
      context.addIssue({ code: "custom", path: ["groups"], message: "group ordinals are not contiguous" });
    }
    const ordinals = new Set(value.intervals.map((interval) => interval.ordinal));
    if (value.groups.some((group) => group.intervalOrdinals.some((ordinal) => !ordinals.has(ordinal)))) {
      context.addIssue({ code: "custom", path: ["groups"], message: "group references a missing interval" });
    }
  });

export const BestEffortSchema = z
  .object({
    rank: z.number().int().min(1).max(MAX_ACTIVITY_ANALYSIS_EFFORTS),
    startIndex: NonnegativeIntegerSchema,
    endIndex: NonnegativeIntegerSchema,
    durationSeconds: NonnegativeFiniteSchema.max(7 * 86_400),
    distanceMeters: NullableNonnegativeFiniteSchema,
    averageWatts: NonnegativeFiniteSchema.max(100_000),
  })
  .strict()
  .refine((value) => value.startIndex <= value.endIndex, { path: ["endIndex"], message: "effort indexes are reversed" });

export const BestEffortDataSchema = z
  .object({
    scope: z
      .object({
        kind: z.literal("selected-activity"),
        stream: z.literal("power"),
        durationSeconds: z.number().int().min(1).max(7 * 86_400),
        tieRule: z.literal("earliest-start"),
      })
      .strict(),
    efforts: z.array(BestEffortSchema).max(MAX_ACTIVITY_ANALYSIS_EFFORTS),
  })
  .strict()
  .refine((value) => value.efforts.every((effort, index) => effort.rank === index + 1), {
    path: ["efforts"],
    message: "effort ranks are not contiguous",
  });

export const DistributionBucketSchema = z
  .object({
    lower: NonnegativeFiniteSchema,
    upper: NonnegativeFiniteSchema,
    seconds: NonnegativeFiniteSchema.max(7 * 86_400),
  })
  .strict()
  .refine((value) => value.lower < value.upper, { path: ["upper"], message: "bucket is empty" });

export const DistributionDataSchema = z
  .object({
    unit: z.enum(["watts", "bpm"]),
    buckets: z.array(DistributionBucketSchema).max(MAX_ACTIVITY_ANALYSIS_BUCKETS),
    totalSeconds: NonnegativeFiniteSchema.max(7 * 86_400),
  })
  .strict()
  .superRefine((value, context) => {
    for (let index = 1; index < value.buckets.length; index += 1) {
      if (value.buckets[index - 1]!.upper > value.buckets[index]!.lower) {
        context.addIssue({ code: "custom", path: ["buckets", index], message: "buckets overlap" });
      }
    }
    const total = value.buckets.reduce((sum, bucket) => sum + bucket.seconds, 0);
    if (Math.abs(total - value.totalSeconds) > 0.001) {
      context.addIssue({ code: "custom", path: ["totalSeconds"], message: "bucket total mismatch" });
    }
  });

export const PowerHeartRateRowSchema = z
  .object({
    startSeconds: NonnegativeFiniteSchema.max(7 * 86_400),
    watts: NonnegativeFiniteSchema.max(100_000),
    heartRateBpm: NonnegativeFiniteSchema.max(400),
    cadenceRpm: NullableNonnegativeFiniteSchema,
    movingSeconds: NullableNonnegativeFiniteSchema,
    seconds: NonnegativeFiniteSchema.max(7 * 86_400),
  })
  .strict();

export const PowerHeartRateCurveSchema = z
  .object({
    kind: z.enum(["all", "zone-2", "other"]),
    coefficients: z.array(z.number().finite()).min(1).max(16),
    rSquared: z.number().finite().min(0).max(1).nullable(),
  })
  .strict();

export const PowerHeartRateDataSchema = z
  .object({
    source: z.literal("provider"),
    rows: z.array(PowerHeartRateRowSchema).max(MAX_ACTIVITY_ANALYSIS_POWER_HEART_RATE_ROWS),
    curves: z.array(PowerHeartRateCurveSchema).max(MAX_ACTIVITY_ANALYSIS_POWER_HEART_RATE_CURVES),
    coverageFraction: z.number().finite().min(0).max(1),
    heartRateLagSeconds: NullableNonnegativeFiniteSchema,
    warmupSeconds: NullableNonnegativeFiniteSchema,
    cooldownSeconds: NullableNonnegativeFiniteSchema,
  })
  .strict()
  .refine((value) => value.rows.every((row, index) => index === 0 || value.rows[index - 1]!.startSeconds <= row.startSeconds), {
    path: ["rows"],
    message: "power/heart-rate rows are not ordered",
  });

export const ActivityAnalysisDataSchemaMap = {
  aerobicDrift: AerobicDriftDataSchema,
  intervals: IntervalReviewDataSchema,
  bestEfforts: BestEffortDataSchema,
  powerDistribution: DistributionDataSchema.refine((value) => value.unit === "watts", {
    path: ["unit"],
    message: "power distribution must use watts",
  }),
  heartRateDistribution: DistributionDataSchema.refine((value) => value.unit === "bpm", {
    path: ["unit"],
    message: "heart-rate distribution must use bpm",
  }),
  powerHeartRate: PowerHeartRateDataSchema,
} as const;

export interface ActivityAnalysisDataSchemas {
  readonly aerobicDrift: z.ZodType;
  readonly intervals: z.ZodType;
  readonly bestEfforts: z.ZodType;
  readonly powerDistribution: z.ZodType;
  readonly heartRateDistribution: z.ZodType;
  readonly powerHeartRate: z.ZodType;
}

export function createActivityAnalysisResultSchema<T extends ActivityAnalysisDataSchemas>(data: T) {
  const sections = z
    .object({
      aerobicDrift: createAnalysisSectionSchema(data.aerobicDrift).optional(),
      intervals: createAnalysisSectionSchema(data.intervals).optional(),
      bestEfforts: createAnalysisSectionSchema(data.bestEfforts).optional(),
      powerDistribution: createAnalysisSectionSchema(data.powerDistribution).optional(),
      heartRateDistribution: createAnalysisSectionSchema(data.heartRateDistribution).optional(),
      powerHeartRate: createAnalysisSectionSchema(data.powerHeartRate).optional(),
    })
    .strict()
    .refine((value) => Object.keys(value).length > 0, "analysis result needs one section");
  return z
    .object({
      schemaVersion: z.literal(ACTIVITY_ANALYSIS_SCHEMA_VERSION),
      activity: CanonicalActivitySummarySchema,
      revision: ActivityAnalysisRevisionSchema,
      sections,
    })
    .strict();
}

const ConcreteActivityAnalysisResultSchema = createActivityAnalysisResultSchema(
  ActivityAnalysisDataSchemaMap,
).superRefine((value, context) => {
  const intervals = value.sections.intervals;
  const intervalEvidence = intervals?.kind === "stale"
    ? intervals.lastGood
    : intervals?.kind === "computed" ? intervals : undefined;
  if (
    intervalEvidence !== undefined
    && (intervalEvidence.data as { readonly source?: unknown }).source
      !== intervalEvidence.provenance.source
  ) {
    context.addIssue({
      code: "custom",
      path: ["sections", "intervals", "provenance", "source"],
      message: "interval source and provenance disagree",
    });
  }
  const powerHeartRate = value.sections.powerHeartRate;
  const powerHeartRateEvidence = powerHeartRate?.kind === "stale"
    ? powerHeartRate.lastGood
    : powerHeartRate?.kind === "computed" ? powerHeartRate : undefined;
  if (
    powerHeartRateEvidence !== undefined
    && powerHeartRateEvidence.provenance.source !== "provider"
  ) {
    context.addIssue({
      code: "custom",
      path: ["sections", "powerHeartRate", "provenance", "source"],
      message: "power/heart-rate provenance must be provider data",
    });
  }
});

export const ActivityAnalysisResultSchema = ConcreteActivityAnalysisResultSchema.refine(
  (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_ACTIVITY_ANALYSIS_RESPONSE_BYTES,
  "activity analysis response is too large",
);

export type ActivityAnalysisSection = z.infer<typeof ActivityAnalysisSectionSchema>;
export type ActivityAnalysisRequest = z.infer<typeof ActivityAnalysisRequestSchema>;
export type CanonicalActivitySummary = z.infer<typeof CanonicalActivitySummarySchema>;
export type AnalysisProvenance = z.infer<typeof AnalysisProvenanceSchema>;
export type AnalysisUnavailableReason = z.infer<typeof AnalysisUnavailableReasonSchema>;
export type AnalysisRefreshFailureCode = z.infer<typeof AnalysisRefreshFailureCodeSchema>;
export type AnalysisRefreshFailure = z.infer<typeof AnalysisRefreshFailureSchema>;

export interface AnalysisComputed<T> {
  readonly kind: "computed";
  readonly data: T;
  readonly provenance: AnalysisProvenance;
}

export type AnalysisSection<T> =
  | AnalysisComputed<T>
  | { readonly kind: "unavailable"; readonly reason: AnalysisUnavailableReason }
  | {
      readonly kind: "stale";
      readonly lastGood: AnalysisComputed<T>;
      readonly refreshFailure: AnalysisRefreshFailure;
    };

export interface ActivityAnalysisData {
  readonly aerobicDrift: z.infer<typeof AerobicDriftDataSchema>;
  readonly intervals: z.infer<typeof IntervalReviewDataSchema>;
  readonly bestEfforts: z.infer<typeof BestEffortDataSchema>;
  readonly powerDistribution: z.infer<(typeof ActivityAnalysisDataSchemaMap)["powerDistribution"]>;
  readonly heartRateDistribution: z.infer<(typeof ActivityAnalysisDataSchemaMap)["heartRateDistribution"]>;
  readonly powerHeartRate: z.infer<typeof PowerHeartRateDataSchema>;
}

export type ActivityAnalysisResult<T extends ActivityAnalysisData = ActivityAnalysisData> = {
  readonly schemaVersion: typeof ACTIVITY_ANALYSIS_SCHEMA_VERSION;
  readonly activity: CanonicalActivitySummary;
  readonly revision: string;
  readonly sections: {
    readonly [K in keyof ActivityAnalysisData]?: AnalysisSection<T[K]>;
  };
};
