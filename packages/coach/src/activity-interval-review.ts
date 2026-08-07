import {
  IntervalReviewDataSchema,
  MAX_ACTIVITY_ANALYSIS_INTERVAL_GROUPS,
  MAX_ACTIVITY_ANALYSIS_INTERVALS,
  type ActivityAnalysisData,
  type AnalysisUnavailableReason,
} from "@enduragent/coach-contract";
import { z } from "zod";
import type { ActivityIntervals } from "intervals-icu-api";
import type { ProviderActivityIntervalsArchive } from "./activity-analysis-archive.js";
import {
  ActivityAnalysisComputationError,
  type ActivityAnalysisSectionInput,
  type ActivityAnalysisSectionAnalyzer,
  type ActivityAnalysisSectionOutput,
} from "./activity-analysis-service.js";
import {
  providerActivityFailure,
  type ProviderActivityAnalysisClientAccess,
} from "./activity-analysis-provider.js";

export const ACTIVITY_INTERVAL_RESPONSE_LIMIT_BYTES = 2 * 1_024 * 1_024;

const MAX_ACTIVITY_SECONDS = 7 * 86_400;
const MAX_ACTIVITY_SAMPLES = 1_000_000;
const MAX_DISPLAY_METRIC = 100_000;

const NullableDuration = z.number().finite().nonnegative().max(MAX_ACTIVITY_SECONDS).nullish();
const NullableIndex = z.number().int().nonnegative().max(MAX_ACTIVITY_SAMPLES).nullish();
const NullableMetric = z.number().finite().nonnegative().max(MAX_DISPLAY_METRIC).nullish();
const NullableDistance = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).nullish();
const NullableZone = z.number().int().min(0).max(100).nullish();
const NullableIntensity = z.number().finite().min(0).max(10_000).nullish();
const NullableLabel = z.string().min(1).max(128).nullish();
const NullableGroupId = z.string().min(1).max(128).nullish();

const IntervalMetricsShape = {
  movingTime: NullableDuration,
  elapsedTime: NullableDuration,
  distance: NullableDistance,
  averageWatts: NullableMetric,
  maxWatts: NullableMetric,
  averageHeartrate: z.number().finite().nonnegative().max(400).nullish(),
  maxHeartrate: z.number().finite().nonnegative().max(400).nullish(),
  averageCadence: NullableMetric,
  maxCadence: NullableMetric,
  zone: NullableZone,
  intensity: NullableIntensity,
  trainingLoad: NullableMetric,
} as const;

const ProviderIntervalSchema = z
  .object({
    ...IntervalMetricsShape,
    groupId: NullableGroupId,
    label: NullableLabel,
    type: z.enum(["WORK", "RECOVERY"]).nullish(),
    startIndex: NullableIndex,
    endIndex: NullableIndex,
    startTime: NullableDuration,
    endTime: NullableDuration,
  })
  .passthrough();

const ProviderIntervalGroupSchema = z
  .object({
    ...IntervalMetricsShape,
    id: NullableGroupId,
  })
  .passthrough();

const ProviderIntervalsSchema = z
  .object({
    icuIntervals: z.array(ProviderIntervalSchema).max(MAX_ACTIVITY_ANALYSIS_INTERVALS).nullish(),
    icuGroups: z
      .array(ProviderIntervalGroupSchema)
      .max(MAX_ACTIVITY_ANALYSIS_INTERVAL_GROUPS)
      .nullish(),
  })
  .passthrough();

type ProviderInterval = z.infer<typeof ProviderIntervalSchema>;
type ProviderIntervalGroup = z.infer<typeof ProviderIntervalGroupSchema>;
type IntervalKind = ActivityAnalysisData["intervals"]["intervals"][number]["kind"];

export interface ProviderActivityIntervalReader {
  read(input: {
    readonly providerActivityId: string;
    readonly sourceRevision: string;
    readonly signal: AbortSignal;
  }): Promise<ActivityIntervals>;
}

function providerKind(value: ProviderInterval["type"]): IntervalKind {
  if (value === "WORK") return "work";
  if (value === "RECOVERY") return "recovery";
  return "unknown";
}

function projectedMetrics(value: ProviderInterval | ProviderIntervalGroup) {
  return {
    movingSeconds: value.movingTime ?? null,
    elapsedSeconds: value.elapsedTime ?? null,
    averagePowerWatts: value.averageWatts ?? null,
    maximumPowerWatts: value.maxWatts ?? null,
    averageHeartRateBpm: value.averageHeartrate ?? null,
    maximumHeartRateBpm: value.maxHeartrate ?? null,
    averageCadenceRpm: value.averageCadence ?? null,
    maximumCadenceRpm: value.maxCadence ?? null,
    zone: value.zone ?? null,
    intensityPercent: value.intensity ?? null,
    trainingLoad: value.trainingLoad ?? null,
  };
}

function oversized(response: ActivityIntervals): boolean {
  return (
    (Array.isArray(response.icuIntervals) &&
      response.icuIntervals.length > MAX_ACTIVITY_ANALYSIS_INTERVALS) ||
    (Array.isArray(response.icuGroups) &&
      response.icuGroups.length > MAX_ACTIVITY_ANALYSIS_INTERVAL_GROUPS)
  );
}

export function projectProviderActivityIntervals(
  response: ActivityIntervals,
): ActivityAnalysisData["intervals"] {
  if (oversized(response)) {
    throw new ActivityAnalysisComputationError("response-too-large");
  }
  let parsed: z.infer<typeof ProviderIntervalsSchema>;
  try {
    parsed = ProviderIntervalsSchema.parse(response);
  } catch (error) {
    throw new ActivityAnalysisComputationError("malformed-response", { cause: error });
  }
  const rawIntervals = parsed.icuIntervals ?? [];
  const rawGroups = parsed.icuGroups ?? [];
  const groupsById = new Map<string, ProviderIntervalGroup>();
  for (const group of rawGroups) {
    if (group.id === null || group.id === undefined || groupsById.has(group.id)) {
      throw new ActivityAnalysisComputationError("malformed-response");
    }
    groupsById.set(group.id, group);
  }
  const referencedGroupIds = new Set<string>();
  for (const interval of rawIntervals) {
    if (interval.groupId === null || interval.groupId === undefined) continue;
    if (!groupsById.has(interval.groupId)) {
      throw new ActivityAnalysisComputationError("malformed-response");
    }
    referencedGroupIds.add(interval.groupId);
  }
  const projectedGroups = rawGroups.filter(
    (group): group is ProviderIntervalGroup & { readonly id: string } =>
      group.id !== null && group.id !== undefined && referencedGroupIds.has(group.id),
  );
  const groupOrdinals = new Map(
    projectedGroups.map((group, index) => [group.id, index + 1] as const),
  );
  const intervals = rawIntervals.map((interval, index) => ({
    ordinal: index + 1,
    groupOrdinal:
      interval.groupId === null || interval.groupId === undefined
        ? null
        : (groupOrdinals.get(interval.groupId) ?? null),
    kind: providerKind(interval.type),
    label: interval.label ?? null,
    startIndex: interval.startIndex ?? null,
    endIndex: interval.endIndex ?? null,
    startSeconds: interval.startTime ?? null,
    endSeconds: interval.endTime ?? null,
    distanceMeters: interval.distance ?? null,
    ...projectedMetrics(interval),
  }));
  const groups = projectedGroups.map((group, index) => {
    const intervalOrdinals = intervals
      .filter((interval) => interval.groupOrdinal === index + 1)
      .map((interval) => interval.ordinal);
    const kinds = new Set(intervalOrdinals.map((ordinal) => intervals[ordinal - 1]!.kind));
    const kind: IntervalKind =
      kinds.size === 1 ? intervals[intervalOrdinals[0]! - 1]!.kind : "unknown";
    return {
      ordinal: index + 1,
      intervalOrdinals,
      kind,
      ...projectedMetrics(group),
    };
  });
  try {
    return IntervalReviewDataSchema.parse({ source: "provider", intervals, groups });
  } catch (error) {
    throw new ActivityAnalysisComputationError("malformed-response", { cause: error });
  }
}

function localIntervalReview(
  activity: Parameters<ActivityAnalysisSectionAnalyzer<"intervals">["analyze"]>[0]["activity"],
):
  | { readonly kind: "computed"; readonly data: ActivityAnalysisData["intervals"] }
  | { readonly kind: "unavailable"; readonly reason: AnalysisUnavailableReason } {
  if (activity.laps.length > MAX_ACTIVITY_ANALYSIS_INTERVALS) {
    return { kind: "unavailable", reason: "response-too-large" };
  }
  const intervals = activity.laps.map((lap, index) => {
    const startSeconds =
      lap.startEpochSeconds === null ? null : lap.startEpochSeconds - activity.startEpochSeconds;
    const safeStart =
      startSeconds !== null && startSeconds >= 0 && startSeconds <= MAX_ACTIVITY_SECONDS
        ? startSeconds
        : null;
    const elapsed =
      lap.elapsedSeconds !== null && lap.elapsedSeconds <= MAX_ACTIVITY_SECONDS
        ? lap.elapsedSeconds
        : null;
    return {
      ordinal: index + 1,
      groupOrdinal: null,
      kind: "lap" as const,
      label: null,
      startIndex: null,
      endIndex: null,
      startSeconds: safeStart,
      endSeconds: safeStart === null || elapsed === null ? null : safeStart + elapsed,
      movingSeconds: null,
      elapsedSeconds: elapsed,
      distanceMeters: lap.distanceMeters,
      averagePowerWatts: null,
      maximumPowerWatts: null,
      averageHeartRateBpm: null,
      maximumHeartRateBpm: null,
      averageCadenceRpm: null,
      maximumCadenceRpm: null,
      zone: null,
      intensityPercent: null,
      trainingLoad: null,
    };
  });
  try {
    return {
      kind: "computed",
      data: IntervalReviewDataSchema.parse({
        source: "local-canonical",
        intervals,
        groups: [],
      }),
    };
  } catch {
    return { kind: "unavailable", reason: "unsuitable-activity" };
  }
}

export function createProviderActivityIntervalReader(input: {
  readonly access: ProviderActivityAnalysisClientAccess;
  readonly archive: ProviderActivityIntervalsArchive;
}): ProviderActivityIntervalReader {
  return Object.freeze({
    async read(request: {
      readonly providerActivityId: string;
      readonly sourceRevision: string;
      readonly signal: AbortSignal;
    }) {
      const lease = await input.access.open({
        sourceRevision: request.sourceRevision,
        signal: request.signal,
        maximumBytes: ACTIVITY_INTERVAL_RESPONSE_LIMIT_BYTES,
      });
      const result = await lease.client.activities.getIntervals(request.providerActivityId);
      request.signal.throwIfAborted();
      if (!result.ok) {
        providerActivityFailure(result.error, lease.responseLimitExceeded(), request.signal);
      }
      await input.archive.write({
        sourceRevision: request.sourceRevision,
        response: result.value,
        signal: request.signal,
      });
      request.signal.throwIfAborted();
      return result.value;
    },
  });
}

export function createIntervalReviewAnalyzer(input: {
  readonly provider: ProviderActivityIntervalReader;
}): ActivityAnalysisSectionAnalyzer<"intervals"> {
  return Object.freeze({
    async analyze(
      request: ActivityAnalysisSectionInput,
    ): Promise<ActivityAnalysisSectionOutput<"intervals">> {
      request.signal.throwIfAborted();
      if (request.source.kind !== "resolved") {
        const local = localIntervalReview(request.activity);
        return local.kind === "computed" ? { ...local, source: "local-canonical" } : local;
      }
      const response = await input.provider.read({
        providerActivityId: request.source.providerActivityId,
        sourceRevision: request.sourceRevision,
        signal: request.signal,
      });
      return {
        kind: "computed",
        source: "provider",
        data: projectProviderActivityIntervals(response),
      };
    },
  });
}
