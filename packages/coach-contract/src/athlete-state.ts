import { z } from "zod";
import { CanonicalActivityIdSchema } from "./activity-analysis.js";
import { isActiveIanaZone } from "./time-zone.js";
import { CivilDateSchema } from "./training-export.js";

export { CivilDateSchema } from "./training-export.js";

export const FreshnessSchema = z.enum(["fresh", "flag", "stale", "critical"]);
export type Freshness = z.infer<typeof FreshnessSchema>;

const POWER_PROGRESS_DURATIONS = [5, 60, 300, 1_200, 3_600] as const;
const POWER_PROGRESS_HR_DURATIONS = [60, 300, 1_200, 3_600] as const;

function civilEpochDay(value: string): number {
  return Date.parse(`${value}T00:00:00.000Z`) / 86_400_000;
}

const ISO_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/u;

function isFiniteIsoInstant(value: string): boolean {
  const match = ISO_INSTANT_PATTERN.exec(value);
  if (match === null) return false;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return false;
  const offsetHours = Number(match[9] ?? 0);
  const offsetMinutes = Number(match[10] ?? 0);
  if (offsetHours > 23 || offsetMinutes > 59) return false;
  const offsetSign = match[8] === "-" ? -1 : 1;
  const local = new Date(milliseconds + offsetSign * (offsetHours * 60 + offsetMinutes) * 60_000);
  return (
    local.getUTCFullYear() === Number(match[1]) &&
    local.getUTCMonth() + 1 === Number(match[2]) &&
    local.getUTCDate() === Number(match[3]) &&
    local.getUTCHours() === Number(match[4]) &&
    local.getUTCMinutes() === Number(match[5]) &&
    local.getUTCSeconds() === Number(match[6])
  );
}

function utf8LenAtMost(maximumBytes: number): (value: string) => boolean {
  const encoder = new TextEncoder();
  return (value) => encoder.encode(value).byteLength <= maximumBytes;
}

function isMondayWeek(value: { readonly start: string; readonly end: string }): boolean {
  return (
    ((civilEpochDay(value.start) % 7) + 7) % 7 === 4 &&
    civilEpochDay(value.end) - civilEpochDay(value.start) === 6
  );
}

const PowerProgressDateSchema = z
  .string()
  .length(10)
  .refine((value) => CivilDateSchema.safeParse(value).success, "invalid civil date");

export const CivilDateWindowSchema = z
  .object({
    start: PowerProgressDateSchema,
    end: PowerProgressDateSchema,
  })
  .strict()
  .refine((value) => value.start <= value.end, "date window start must not follow its end");

export const IsoInstantSchema = z
  .string()
  .max(64)
  .datetime({ offset: true })
  .refine(isFiniteIsoInstant);

export const CanonicalSessionIdSchema = CanonicalActivityIdSchema;

const CalendarTimeZoneSchema = z
  .string()
  .min(1)
  .refine(isActiveIanaZone)
  .refine(utf8LenAtMost(255));

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
    durationSeconds: z.number().int().nonnegative().nullable().optional(),
    load: z.number().finite().nonnegative().nullable().optional(),
    description: z.string().nullable().optional(),
    workoutDoc: z.unknown().nullable().optional(),
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

type MetricValueOutput =
  | { kind: "computed"; value: number }
  | { kind: "partial"; value: number; reason: "incomplete-coverage" }
  | {
      kind: "unavailable";
      reason: "no-recorded-value" | "incomplete-coverage" | "invalid-recorded-value";
    };

type MissingRecordedMetricValueOutput = {
  kind: "partial";
  value: number;
  reason: "missing-recorded-value";
  knownRideMissingValueCount: number;
};

function metricValueSchema(
  value: z.ZodNumber,
  options: { readonly countsMissingRides: false },
): z.ZodType<MetricValueOutput>;
function metricValueSchema(
  value: z.ZodNumber,
  options: { readonly countsMissingRides: true },
): z.ZodType<MetricValueOutput | MissingRecordedMetricValueOutput>;
function metricValueSchema(
  value: z.ZodNumber,
  options: { readonly countsMissingRides: boolean },
): z.ZodType<MetricValueOutput | MissingRecordedMetricValueOutput> {
  const computed = z.object({ kind: z.literal("computed"), value }).strict();
  const incomplete = z
    .object({
      kind: z.literal("partial"),
      value,
      reason: z.literal("incomplete-coverage"),
    })
    .strict();
  const unavailable = z
    .object({
      kind: z.literal("unavailable"),
      reason: z.enum([
        "no-recorded-value",
        "incomplete-coverage",
        "invalid-recorded-value",
      ]),
    })
    .strict();
  if (!options.countsMissingRides) {
    return z.union([computed, incomplete, unavailable]);
  }
  const missing = z
    .object({
      kind: z.literal("partial"),
      value,
      reason: z.literal("missing-recorded-value"),
      knownRideMissingValueCount: z.number().int().min(1).max(1_000),
    })
    .strict();
  return z.union([computed, missing, incomplete, unavailable]);
}

export const RideCountMetricValueSchema = metricValueSchema(
  z.number().int().min(0).max(1_000),
  { countsMissingRides: false },
);
export const DurationMetricValueSchema = metricValueSchema(
  z.number().int().safe().nonnegative(),
  { countsMissingRides: true },
);
export const DistanceMetricValueSchema = metricValueSchema(
  z.number().finite().min(0).max(100_000_000),
  { countsMissingRides: true },
);
export const LoadMetricValueSchema = metricValueSchema(
  z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER),
  { countsMissingRides: true },
);

export const TrainingHistoryRideSchema = z
  .object({
    id: CanonicalSessionIdSchema,
    title: z.string().refine(utf8LenAtMost(512)).nullable(),
    subSport: z.string().min(1).max(128).nullable(),
    startEpochSeconds: z.number().int().safe().nonnegative(),
    timezoneOffsetSeconds: z.number().int().min(-86_400).max(86_400).nullable(),
    localDate: CivilDateSchema,
    ridingSeconds: z.number().int().safe().nonnegative().nullable(),
    ridingTimeBasis: z.enum(["moving", "elapsed"]).nullable(),
    elapsedSeconds: z.number().int().safe().nonnegative().nullable(),
    distanceMeters: z.number().finite().min(0).max(100_000_000).nullable(),
    load: z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    averagePowerWatts: z.number().finite().min(0).max(20_000).nullable(),
    averageHeartRateBpm: z.number().finite().positive().max(500).nullable(),
    perceivedExertion: z.number().finite().min(0).max(10).nullable(),
    energyKilojoules: z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.ridingSeconds === null) !== (value.ridingTimeBasis === null)) {
      context.addIssue({
        code: "custom",
        path: ["ridingTimeBasis"],
        message: "riding seconds and riding time basis must be present together",
      });
    }
  });

export const WeekCoverageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("complete") }).strict(),
  z
    .object({
      kind: z.literal("incomplete"),
      recordedThrough: CivilDateSchema.nullable(),
      reason: z.enum([
        "backfill-incomplete",
        "source-degraded",
        "sparse-imports",
        "coverage-timezone-changed",
        "coverage-lag",
        "scan-limit",
        "invalid-core-record",
      ]),
    })
    .strict(),
]);

export const TrendBucketSchema = z
  .object({
    window: CivilDateWindowSchema,
    rideCount: z.number().int().min(0).max(1_000),
    ridingSeconds: z.number().int().safe().nonnegative(),
  })
  .strict();

export const RidingTimeTrendSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("computed"),
      buckets: z.array(TrendBucketSchema).length(6),
    })
    .strict()
    .superRefine((value, context) => {
      for (let index = 0; index < value.buckets.length; index += 1) {
        const bucket = value.buckets[index]!;
        if (!isMondayWeek(bucket.window)) {
          context.addIssue({
            code: "custom",
            path: ["buckets", index, "window"],
            message: "trend buckets must be closed Monday weeks",
          });
        }
        if (
          index > 0 &&
          civilEpochDay(bucket.window.start) -
            civilEpochDay(value.buckets[index - 1]!.window.end) !==
            1
        ) {
          context.addIssue({
            code: "custom",
            path: ["buckets", index, "window"],
            message: "trend buckets must be contiguous and ascending",
          });
        }
      }
    }),
  z
    .object({
      kind: z.literal("unavailable"),
      reason: z.enum(["limited-history", "incomplete-source", "missing-duration"]),
    })
    .strict(),
]);

export const TrainingRideCalloutSchema = z
  .object({
    kind: z.literal("longest-ride-28d"),
    rideId: CanonicalSessionIdSchema,
    durationSeconds: z.number().int().safe().positive(),
    window: CivilDateWindowSchema,
    comparisonRideCount: z.number().int().min(4).max(1_000),
  })
  .strict()
  .superRefine((value, context) => {
    if (civilEpochDay(value.window.end) - civilEpochDay(value.window.start) !== 27) {
      context.addIssue({
        code: "custom",
        path: ["window"],
        message: "callout window must contain 28 civil dates",
      });
    }
  });

export const CompletedActivityWeekSchema = z
  .object({
    id: z.enum(["anchor", "previous"]),
    window: CivilDateWindowSchema,
    calendarState: z.enum(["open", "closed"]),
    coverage: WeekCoverageSchema,
    totals: z
      .object({
        rideCount: RideCountMetricValueSchema,
        ridingSeconds: DurationMetricValueSchema,
        distanceMeters: DistanceMetricValueSchema,
        load: LoadMetricValueSchema,
      })
      .strict(),
    rides: z
      .object({
        count: z.union([
          z
            .object({
              kind: z.literal("exact"),
              value: z.number().int().min(0).max(1_000),
            })
            .strict(),
          z
            .object({
              kind: z.literal("at-least"),
              value: z.number().int().min(0).max(1_000),
            })
            .strict(),
        ]),
        items: z.array(TrainingHistoryRideSchema).max(50),
        truncated: z.boolean(),
      })
      .strict(),
    trend: RidingTimeTrendSchema,
    callout: TrainingRideCalloutSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!isMondayWeek(value.window)) {
      context.addIssue({
        code: "custom",
        path: ["window"],
        message: "completed activity week must run from Monday through Sunday",
      });
    }
    const ids = new Set<string>();
    for (let index = 0; index < value.rides.items.length; index += 1) {
      const ride = value.rides.items[index]!;
      if (ride.localDate < value.window.start || ride.localDate > value.window.end) {
        context.addIssue({
          code: "custom",
          path: ["rides", "items", index, "localDate"],
          message: "ride local date must fall inside the week",
        });
      }
      if (ids.has(ride.id)) {
        context.addIssue({
          code: "custom",
          path: ["rides", "items", index, "id"],
          message: "ride ids must be unique within a week",
        });
      }
      ids.add(ride.id);
      if (index > 0) {
        const previous = value.rides.items[index - 1]!;
        if (
          previous.startEpochSeconds < ride.startEpochSeconds ||
          (previous.startEpochSeconds === ride.startEpochSeconds && previous.id > ride.id)
        ) {
          context.addIssue({
            code: "custom",
            path: ["rides", "items", index],
            message: "rides must be sorted by start time descending and id ascending",
          });
        }
      }
    }
    if (value.rides.count.value < value.rides.items.length) {
      context.addIssue({
        code: "custom",
        path: ["rides", "count", "value"],
        message: "ride count must include every returned ride",
      });
    }
    const shouldBeTruncated =
      value.rides.count.kind === "at-least" ||
      value.rides.count.value > value.rides.items.length;
    if (value.rides.truncated !== shouldBeTruncated) {
      context.addIssue({
        code: "custom",
        path: ["rides", "truncated"],
        message: "ride truncation must match the count envelope",
      });
    }
    if (value.callout !== null) {
      const ride = value.rides.items.find((item) => item.id === value.callout?.rideId);
      if (ride === undefined) {
        context.addIssue({
          code: "custom",
          path: ["callout", "rideId"],
          message: "callout ride must be returned in the week",
        });
      } else if (ride.ridingSeconds !== value.callout.durationSeconds) {
        context.addIssue({
          code: "custom",
          path: ["callout", "durationSeconds"],
          message: "callout duration must match the returned ride",
        });
      }
    }
  });

export const TrainingHistoryCoverageSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("contiguous"),
      start: CivilDateSchema,
      through: CivilDateSchema,
      committedAt: IsoInstantSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("incomplete"),
      provenStart: CivilDateSchema.nullable(),
      provenThrough: CivilDateSchema.nullable(),
      observedThrough: CivilDateSchema.nullable(),
      committedAt: IsoInstantSchema.nullable(),
      reason: z.enum([
        "backfill-incomplete",
        "source-degraded",
        "undated-dropped-rows",
        "coverage-timezone-changed",
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("sparse"),
      latestKnownRideDate: CivilDateSchema,
      latestImportAt: IsoInstantSchema.nullable(),
    })
    .strict(),
]);

export const TrainingHistoryComputedSchema = z
  .object({
    kind: z.literal("computed"),
    asOf: IsoInstantSchema,
    calendarTimeZone: CalendarTimeZoneSchema,
    displayMode: z.enum(["current", "last-recorded"]),
    coverage: TrainingHistoryCoverageSchema,
    anchorWeek: CompletedActivityWeekSchema,
    previousWeek: CompletedActivityWeekSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.anchorWeek.id !== "anchor") {
      context.addIssue({
        code: "custom",
        path: ["anchorWeek", "id"],
        message: "anchor week must carry the anchor id",
      });
    }
    if (value.previousWeek !== null) {
      if (value.previousWeek.id !== "previous") {
        context.addIssue({
          code: "custom",
          path: ["previousWeek", "id"],
          message: "previous week must carry the previous id",
        });
      }
      if (
        civilEpochDay(value.anchorWeek.window.start) -
          civilEpochDay(value.previousWeek.window.end) !==
        1
      ) {
        context.addIssue({
          code: "custom",
          path: ["previousWeek", "window"],
          message: "previous week must end before the anchor week starts",
        });
      }
    }
  });

const TrainingHistoryUnavailableSchema = z
  .object({
    kind: z.literal("unavailable"),
    reason: z.enum([
      "not-synced",
      "coverage-unavailable",
      "temporary-failure",
      "invalid-data",
    ]),
  })
  .strict();

export const TrainingHistoryProjectionSchema = z.discriminatedUnion("kind", [
  TrainingHistoryComputedSchema,
  TrainingHistoryUnavailableSchema,
]);

const TrainingHistoryStaleSchema = z
  .object({
    kind: z.literal("stale"),
    failedAt: IsoInstantSchema,
    reason: z.literal("temporary-failure"),
    lastGood: TrainingHistoryComputedSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.lastGood.anchorWeek.callout !== null ||
      (value.lastGood.previousWeek !== null && value.lastGood.previousWeek.callout !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["lastGood"],
        message: "last-good training history cannot carry callouts",
      });
    }
  });

export const TrainingHistoryPanelSchema = z.discriminatedUnion("kind", [
  ...TrainingHistoryProjectionSchema.options,
  TrainingHistoryStaleSchema,
]);

export const CyclingTrainingContextSchema = z
  .object({
    performanceProgress: PowerProgressPanelSchema,
    recentRides: RecentRidesPanelSchema.default({ kind: "unknown", reason: "not-synced" }),
    trainingHistory: TrainingHistoryPanelSchema,
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
export type IsoInstant = z.infer<typeof IsoInstantSchema>;
export type CivilDate = z.infer<typeof CivilDateSchema>;
export type CivilDateWindow = z.infer<typeof CivilDateWindowSchema>;
export type CanonicalSessionId = z.infer<typeof CanonicalSessionIdSchema>;
export type RideCountMetricValue = z.infer<typeof RideCountMetricValueSchema>;
export type DurationMetricValue = z.infer<typeof DurationMetricValueSchema>;
export type DistanceMetricValue = z.infer<typeof DistanceMetricValueSchema>;
export type LoadMetricValue = z.infer<typeof LoadMetricValueSchema>;
export type TrainingHistoryRide = z.infer<typeof TrainingHistoryRideSchema>;
export type WeekCoverage = z.infer<typeof WeekCoverageSchema>;
export type TrendBucket = z.infer<typeof TrendBucketSchema>;
export type RidingTimeTrend = z.infer<typeof RidingTimeTrendSchema>;
export type TrainingRideCallout = z.infer<typeof TrainingRideCalloutSchema>;
export type CompletedActivityWeek = z.infer<typeof CompletedActivityWeekSchema>;
export type TrainingHistoryCoverage = z.infer<typeof TrainingHistoryCoverageSchema>;
export type TrainingHistoryComputed = z.infer<typeof TrainingHistoryComputedSchema>;
export type TrainingHistoryProjection = z.infer<typeof TrainingHistoryProjectionSchema>;
export type TrainingHistoryPanel = z.infer<typeof TrainingHistoryPanelSchema>;
export type CyclingTrainingContext = z.infer<typeof CyclingTrainingContextSchema>;

export const UNKNOWN_CYCLING_TRAINING_CONTEXT: CyclingTrainingContext = {
  performanceProgress: { kind: "unavailable", reason: "not-synced" },
  recentRides: { kind: "unknown", reason: "not-synced" },
  trainingHistory: { kind: "unavailable", reason: "not-synced" },
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
