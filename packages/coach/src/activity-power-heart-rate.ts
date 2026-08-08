import {
  MAX_ACTIVITY_ANALYSIS_POWER_HEART_RATE_CURVES,
  MAX_ACTIVITY_ANALYSIS_POWER_HEART_RATE_ROWS,
  PowerHeartRateDataSchema,
  type ActivityAnalysisData,
} from "@enduragent/coach-contract";
import { z } from "zod";
import type { PowerVsHeartRatePlot } from "intervals-icu-api";
import type { ProviderActivityPowerHeartRateArchive } from "./activity-analysis-archive.js";
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

export const ACTIVITY_POWER_HEART_RATE_RESPONSE_LIMIT_BYTES = 2 * 1_024 * 1_024;
export const MINIMUM_POWER_HEART_RATE_ROWS = 5;
export const MINIMUM_POWER_HEART_RATE_SECONDS = 5 * 60;
export const MINIMUM_POWER_HEART_RATE_COVERAGE = 0.5;

const MAX_ACTIVITY_SECONDS = 7 * 86_400;
const NullableActivitySeconds = z
  .number()
  .finite()
  .nonnegative()
  .max(MAX_ACTIVITY_SECONDS)
  .nullish();

const ProviderPowerHeartRateRowSchema = z
  .object({
    start: z.number().finite().nonnegative().max(MAX_ACTIVITY_SECONDS),
    watts: z.number().finite().nonnegative().max(100_000),
    hr: z.number().finite().positive().max(400),
    cadence: z.number().finite().nonnegative().max(1_000).nullish(),
    movingSecs: NullableActivitySeconds,
    secs: z.number().finite().positive().max(MAX_ACTIVITY_SECONDS),
  })
  .passthrough()
  .refine(
    (value) =>
      value.movingSecs === null || value.movingSecs === undefined || value.movingSecs <= value.secs,
    { path: ["movingSecs"], message: "moving time exceeds segment duration" },
  );

const ProviderPowerHeartRateCurveSchema = z
  .object({
    id: z.string().max(128).nullish(),
    coefficients: z.array(z.number().finite().nullable()).max(16).nullish(),
    r2: z.number().finite().min(0).max(1).nullish(),
  })
  .passthrough();

const ProviderPowerHeartRateSchema = z
  .object({
    elapsedTime: NullableActivitySeconds,
    hrLag: NullableActivitySeconds,
    warmup: NullableActivitySeconds,
    cooldown: NullableActivitySeconds,
    series: z
      .array(ProviderPowerHeartRateRowSchema)
      .max(MAX_ACTIVITY_ANALYSIS_POWER_HEART_RATE_ROWS),
    curves: z
      .array(ProviderPowerHeartRateCurveSchema)
      .max(MAX_ACTIVITY_ANALYSIS_POWER_HEART_RATE_CURVES)
      .nullish(),
  })
  .passthrough();

type ProviderPowerHeartRateCurve = z.infer<typeof ProviderPowerHeartRateCurveSchema>;

export interface ProviderActivityPowerHeartRateReader {
  read(input: ProviderActivityPowerHeartRateReadRequest): Promise<PowerVsHeartRatePlot>;
}

interface ProviderActivityPowerHeartRateReadRequest {
  readonly providerActivityId: string;
  readonly sourceRevision: string;
  readonly signal: AbortSignal;
}

function curveKind(
  id: ProviderPowerHeartRateCurve["id"],
): ActivityAnalysisData["powerHeartRate"]["curves"][number]["kind"] {
  const normalized = id
    ?.trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-");
  if (normalized === "z2" || normalized === "zone-2" || normalized === "zone2") return "zone-2";
  if (normalized === "all" || normalized === "overall") return "all";
  return "other";
}

function projectedCurves(curves: readonly ProviderPowerHeartRateCurve[]) {
  return curves.flatMap((curve) => {
    if (
      curve.coefficients === null ||
      curve.coefficients === undefined ||
      curve.coefficients.length === 0
    ) {
      return [];
    }
    if (curve.coefficients.some((coefficient) => coefficient === null)) {
      throw new ActivityAnalysisComputationError("malformed-response");
    }
    return [
      {
        kind: curveKind(curve.id),
        coefficients: curve.coefficients as number[],
        rSquared: curve.r2 ?? null,
      },
    ];
  });
}

export function projectProviderPowerHeartRate(
  response: PowerVsHeartRatePlot,
  activityElapsedSeconds: number | null,
): ActivityAnalysisData["powerHeartRate"] {
  if (
    (Array.isArray(response.series) &&
      response.series.length > MAX_ACTIVITY_ANALYSIS_POWER_HEART_RATE_ROWS) ||
    (Array.isArray(response.curves) &&
      response.curves.length > MAX_ACTIVITY_ANALYSIS_POWER_HEART_RATE_CURVES)
  ) {
    throw new ActivityAnalysisComputationError("response-too-large");
  }
  let parsed: z.infer<typeof ProviderPowerHeartRateSchema>;
  try {
    parsed = ProviderPowerHeartRateSchema.parse(response);
  } catch (error) {
    throw new ActivityAnalysisComputationError("malformed-response", { cause: error });
  }
  const rows = parsed.series.map((row) => ({
    startSeconds: row.start,
    watts: row.watts,
    heartRateBpm: row.hr,
    cadenceRpm: row.cadence ?? null,
    movingSeconds: row.movingSecs ?? null,
    seconds: row.secs,
  }));
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1]!;
    const current = rows[index]!;
    if (previous.startSeconds + previous.seconds > current.startSeconds) {
      throw new ActivityAnalysisComputationError("malformed-response");
    }
  }
  const lastEnd = rows.reduce(
    (maximum, row) => Math.max(maximum, row.startSeconds + row.seconds),
    0,
  );
  const providerElapsed = parsed.elapsedTime ?? null;
  const denominator =
    providerElapsed !== null && providerElapsed > 0
      ? providerElapsed
      : activityElapsedSeconds !== null && activityElapsedSeconds > 0
        ? activityElapsedSeconds
        : lastEnd;
  if (denominator < lastEnd || denominator > MAX_ACTIVITY_SECONDS) {
    throw new ActivityAnalysisComputationError("malformed-response");
  }
  const includedSeconds = rows.reduce((sum, row) => sum + (row.movingSeconds ?? row.seconds), 0);
  if (includedSeconds > denominator) {
    throw new ActivityAnalysisComputationError("malformed-response");
  }
  const coverageFraction = denominator === 0 ? 0 : includedSeconds / denominator;
  try {
    return PowerHeartRateDataSchema.parse({
      source: "provider",
      rows,
      curves: projectedCurves(parsed.curves ?? []),
      coverageFraction,
      heartRateLagSeconds: parsed.hrLag ?? null,
      warmupSeconds: parsed.warmup ?? null,
      cooldownSeconds: parsed.cooldown ?? null,
    });
  } catch (error) {
    if (error instanceof ActivityAnalysisComputationError) throw error;
    throw new ActivityAnalysisComputationError("malformed-response", { cause: error });
  }
}

export function createProviderActivityPowerHeartRateReader(input: {
  readonly access: ProviderActivityAnalysisClientAccess;
  readonly archive: ProviderActivityPowerHeartRateArchive;
}): ProviderActivityPowerHeartRateReader {
  return Object.freeze({
    async read(request: ProviderActivityPowerHeartRateReadRequest) {
      const lease = await input.access.open({
        sourceRevision: request.sourceRevision,
        signal: request.signal,
        maximumBytes: ACTIVITY_POWER_HEART_RATE_RESPONSE_LIMIT_BYTES,
      });
      const result = await lease.client.activities.getPowerVsHeartRate(request.providerActivityId);
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

export function createPowerHeartRateAnalyzer(input: {
  readonly provider: ProviderActivityPowerHeartRateReader;
}): ActivityAnalysisSectionAnalyzer<"powerHeartRate"> {
  return Object.freeze({
    async analyze(
      request: ActivityAnalysisSectionInput,
    ): Promise<ActivityAnalysisSectionOutput<"powerHeartRate">> {
      request.signal.throwIfAborted();
      if (request.source.kind !== "resolved") {
        return { kind: "unavailable", reason: request.source.reason };
      }
      const response = await input.provider.read({
        providerActivityId: request.source.providerActivityId,
        sourceRevision: request.sourceRevision,
        signal: request.signal,
      });
      if (Array.isArray(response.series) && response.series.length === 0) {
        return { kind: "unavailable", reason: "missing-sensor-data" };
      }
      const data = projectProviderPowerHeartRate(response, request.activity.elapsedSeconds);
      const includedSeconds = data.rows.reduce(
        (sum, row) => sum + (row.movingSeconds ?? row.seconds),
        0,
      );
      if (
        data.rows.length < MINIMUM_POWER_HEART_RATE_ROWS ||
        includedSeconds < MINIMUM_POWER_HEART_RATE_SECONDS
      ) {
        return { kind: "unavailable", reason: "activity-too-short" };
      }
      if (data.coverageFraction < MINIMUM_POWER_HEART_RATE_COVERAGE) {
        return { kind: "unavailable", reason: "insufficient-coverage" };
      }
      const watts = data.rows.map((row) => row.watts);
      const heartRates = data.rows.map((row) => row.heartRateBpm);
      if (
        Math.max(...watts) - Math.min(...watts) < 10 ||
        Math.max(...heartRates) - Math.min(...heartRates) < 5
      ) {
        return { kind: "unavailable", reason: "unsuitable-activity" };
      }
      return { kind: "computed", source: "provider", data };
    },
  });
}
