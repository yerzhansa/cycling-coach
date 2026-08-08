import {
  DistributionDataSchema,
  MAX_ACTIVITY_ANALYSIS_BUCKETS,
  type ActivityAnalysisData,
} from "@enduragent/coach-contract";
import { z } from "zod";
import type { HistogramBucket } from "intervals-icu-api";
import type { ProviderActivityHistogramArchive } from "./activity-analysis-archive.js";
import {
  ActivityAnalysisComputationError,
  type ActivityAnalysisSectionAnalyzer,
  type ActivityAnalysisSectionInput,
  type ActivityAnalysisSectionOutput,
} from "./activity-analysis-service.js";
import {
  providerActivityFailure,
  type ProviderActivityAnalysisClientAccess,
} from "./activity-analysis-provider.js";

export const ACTIVITY_HISTOGRAM_RESPONSE_LIMIT_BYTES = 256 * 1_024;

export type ActivityDistributionMetric = "power" | "heart-rate";

interface ProviderActivityHistogramReadRequest {
  readonly providerActivityId: string;
  readonly sourceRevision: string;
  readonly metric: ActivityDistributionMetric;
  readonly signal: AbortSignal;
}

const ProviderHistogramBucketSchema = z
  .object({
    min: z.number().finite().nonnegative(),
    max: z.number().finite().positive(),
    secs: z
      .number()
      .finite()
      .nonnegative()
      .max(7 * 86_400),
  })
  .passthrough()
  .refine((value) => value.min < value.max, {
    path: ["max"],
    message: "histogram bucket is empty",
  });

export interface ProviderActivityHistogramReader {
  read(input: ProviderActivityHistogramReadRequest): Promise<readonly HistogramBucket[]>;
}

function maximumAxis(metric: ActivityDistributionMetric): number {
  return metric === "power" ? 100_000 : 400;
}

function unit(metric: ActivityDistributionMetric): "watts" | "bpm" {
  return metric === "power" ? "watts" : "bpm";
}

export function projectProviderActivityHistogram(
  response: readonly HistogramBucket[],
  metric: ActivityDistributionMetric,
): ActivityAnalysisData["powerDistribution"] {
  if (response.length > MAX_ACTIVITY_ANALYSIS_BUCKETS) {
    throw new ActivityAnalysisComputationError("response-too-large");
  }
  let parsed: readonly z.infer<typeof ProviderHistogramBucketSchema>[];
  try {
    parsed = z
      .array(ProviderHistogramBucketSchema)
      .max(MAX_ACTIVITY_ANALYSIS_BUCKETS)
      .parse(response);
  } catch (error) {
    throw new ActivityAnalysisComputationError("malformed-response", { cause: error });
  }
  const axisLimit = maximumAxis(metric);
  if (parsed.some((bucket) => bucket.min > axisLimit || bucket.max > axisLimit)) {
    throw new ActivityAnalysisComputationError("malformed-response");
  }
  const buckets = parsed.map((bucket) => ({
    lower: bucket.min,
    upper: bucket.max,
    seconds: bucket.secs,
  }));
  const totalSeconds = buckets.reduce((sum, bucket) => sum + bucket.seconds, 0);
  if (!Number.isFinite(totalSeconds) || totalSeconds > 7 * 86_400) {
    throw new ActivityAnalysisComputationError("malformed-response");
  }
  try {
    return DistributionDataSchema.parse({ unit: unit(metric), buckets, totalSeconds });
  } catch (error) {
    throw new ActivityAnalysisComputationError("malformed-response", { cause: error });
  }
}

export function createProviderActivityHistogramReader(input: {
  readonly access: ProviderActivityAnalysisClientAccess;
  readonly archive: ProviderActivityHistogramArchive;
}): ProviderActivityHistogramReader {
  return Object.freeze({
    async read(request: ProviderActivityHistogramReadRequest) {
      const lease = await input.access.open({
        sourceRevision: request.sourceRevision,
        signal: request.signal,
        maximumBytes: ACTIVITY_HISTOGRAM_RESPONSE_LIMIT_BYTES,
      });
      const result =
        request.metric === "power"
          ? await lease.client.activities.getPowerHistogram(request.providerActivityId)
          : await lease.client.activities.getHeartRateHistogram(request.providerActivityId);
      request.signal.throwIfAborted();
      if (!result.ok) {
        providerActivityFailure(result.error, lease.responseLimitExceeded(), request.signal);
      }
      await input.archive.write({
        sourceRevision: request.sourceRevision,
        metric: request.metric,
        response: result.value,
        signal: request.signal,
      });
      request.signal.throwIfAborted();
      return result.value;
    },
  });
}

function analyzeDistribution(
  metric: ActivityDistributionMetric,
  provider: ProviderActivityHistogramReader,
  request: ActivityAnalysisSectionInput,
): Promise<ActivityAnalysisSectionOutput<"powerDistribution" | "heartRateDistribution">> {
  return (async () => {
    request.signal.throwIfAborted();
    if (request.source.kind !== "resolved") {
      return { kind: "unavailable", reason: request.source.reason };
    }
    const response = await provider.read({
      providerActivityId: request.source.providerActivityId,
      sourceRevision: request.sourceRevision,
      metric,
      signal: request.signal,
    });
    if (response.length === 0) {
      return { kind: "unavailable", reason: "missing-sensor-data" };
    }
    return {
      kind: "computed",
      source: "provider",
      data: projectProviderActivityHistogram(response, metric),
    };
  })();
}

export function createPowerDistributionAnalyzer(input: {
  readonly provider: ProviderActivityHistogramReader;
}): ActivityAnalysisSectionAnalyzer<"powerDistribution"> {
  return Object.freeze({
    analyze(request: ActivityAnalysisSectionInput) {
      return analyzeDistribution("power", input.provider, request) as Promise<
        ActivityAnalysisSectionOutput<"powerDistribution">
      >;
    },
  });
}

export function createHeartRateDistributionAnalyzer(input: {
  readonly provider: ProviderActivityHistogramReader;
}): ActivityAnalysisSectionAnalyzer<"heartRateDistribution"> {
  return Object.freeze({
    analyze(request: ActivityAnalysisSectionInput) {
      return analyzeDistribution("heart-rate", input.provider, request) as Promise<
        ActivityAnalysisSectionOutput<"heartRateDistribution">
      >;
    },
  });
}
