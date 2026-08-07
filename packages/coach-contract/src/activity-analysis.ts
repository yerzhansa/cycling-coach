import { z } from "zod";

export const ACTIVITY_ANALYSIS_SCHEMA_VERSION = 1 as const;

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
  ]);
}

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
  readonly aerobicDrift: unknown;
  readonly intervals: unknown;
  readonly bestEfforts: unknown;
  readonly powerDistribution: unknown;
  readonly heartRateDistribution: unknown;
  readonly powerHeartRate: unknown;
}

export type ActivityAnalysisResult<T extends ActivityAnalysisData> = {
  readonly schemaVersion: typeof ACTIVITY_ANALYSIS_SCHEMA_VERSION;
  readonly activity: CanonicalActivitySummary;
  readonly revision: string;
  readonly sections: {
    readonly [K in keyof ActivityAnalysisData]?: AnalysisSection<T[K]>;
  };
};
