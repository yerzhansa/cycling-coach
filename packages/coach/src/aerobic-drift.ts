import type { ActivityAnalysisData, AnalysisUnavailableReason } from "@enduragent/coach-contract";
import type { CanonicalActivityReader } from "@enduragent/kernel/store";
import {
  calculateEfficiencyFactorDecoupling,
  normalizeActivityStreams,
  type ActivityStream,
  type NormalizedActivityStreams,
  type StreamAnalysisIssue,
} from "intervals-icu-api";
import type {
  ActivityAnalysisSectionInput,
  ActivityAnalysisSectionAnalyzer,
  ActivityAnalysisSectionOutput,
} from "./activity-analysis-service.js";
import type { ProviderActivityStreamReader } from "./activity-analysis-provider.js";

const MINIMUM_INCLUDED_SECONDS = 30 * 60;
const MINIMUM_HALF_SECONDS = 15 * 60;
const REFERENCE_DURATION_SECONDS = 60 * 60;
const MINIMUM_COVERAGE = 0.8;
const VARIABLE_OUTPUT_CV = 0.2;

type AerobicDriftEvaluation =
  | { readonly kind: "computed"; readonly data: ActivityAnalysisData["aerobicDrift"] }
  | { readonly kind: "unavailable"; readonly reason: AnalysisUnavailableReason };

function issueReason(issues: readonly StreamAnalysisIssue[]): AnalysisUnavailableReason {
  if (issues.some((issue) => issue.kind === "DuplicateStream")) return "duplicate-stream";
  if (issues.some((issue) => issue.kind === "LengthMismatch")) return "misaligned-stream";
  if (issues.some((issue) => issue.kind === "InvalidTimeStream")) return "invalid-timestamps";
  if (issues.some((issue) => issue.kind === "InvalidMovingStream")) {
    return "moving-status-unavailable";
  }
  if (issues.some((issue) => issue.kind === "MissingStream")) return "missing-sensor-data";
  if (issues.some((issue) => issue.kind === "ZeroEfficiencyFactor")) return "unstable-output";
  return "unsuitable-activity";
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1]! + ordered[middle]!) / 2 : ordered[middle];
}

function outputCoefficientOfVariation(streams: NormalizedActivityStreams): number | undefined {
  const time = streams.getUnique("time");
  const power = streams.getUnique("watts");
  const heartRate = streams.getUnique("heartrate");
  const moving = streams.getUnique("moving");
  if (!time.ok || !power.ok || !heartRate.ok) return undefined;
  if (!moving.ok && moving.error.kind !== "MissingStream") return undefined;
  const timestamps = time.value.data as readonly number[];
  const deltas = timestamps.slice(1).map((value, index) => value - timestamps[index]!);
  const fallback = median(deltas) ?? 1;
  let duration = 0;
  let weightedOutput = 0;
  let weightedOutputSquared = 0;
  for (let index = 0; index < timestamps.length; index += 1) {
    const watts = power.value.data[index];
    const bpm = heartRate.value.data[index];
    const isMoving = moving.ok ? moving.value.data[index] === true : true;
    if (
      typeof watts !== "number" ||
      !Number.isFinite(watts) ||
      typeof bpm !== "number" ||
      !Number.isFinite(bpm) ||
      bpm <= 0 ||
      !isMoving
    ) {
      continue;
    }
    const weight = deltas[index] ?? fallback;
    duration += weight;
    weightedOutput += watts * weight;
    weightedOutputSquared += watts * watts * weight;
  }
  if (!(duration > 0)) return undefined;
  const mean = weightedOutput / duration;
  if (!(mean > 0)) return undefined;
  const variance = Math.max(0, weightedOutputSquared / duration - mean * mean);
  return Math.sqrt(variance) / mean;
}

function hasLongTimestampGap(streams: NormalizedActivityStreams): boolean {
  const time = streams.getUnique("time");
  if (!time.ok) return false;
  const values = time.value.data as readonly number[];
  const deltas = values.slice(1).map((value, index) => value - values[index]!);
  const sampleInterval = median(deltas);
  if (sampleInterval === undefined) return false;
  const maximumGap = Math.max(30, 5 * sampleInterval);
  return deltas.some((gap) => gap > maximumGap);
}

function boundedResult(data: ActivityAnalysisData["aerobicDrift"]): boolean {
  const halves = [data.firstHalf, data.secondHalf];
  return (
    Number.isFinite(data.decouplingPercent) &&
    Math.abs(data.decouplingPercent) <= 1_000 &&
    halves.every(
      (half) =>
        half.durationSeconds >= 0 &&
        half.durationSeconds <= 7 * 86_400 &&
        half.sampleCount >= 0 &&
        half.sampleCount <= 1_000_000 &&
        half.averagePowerWatts >= 0 &&
        half.averagePowerWatts <= 100_000 &&
        half.averageHeartRateBpm >= 0 &&
        half.averageHeartRateBpm <= 400 &&
        half.efficiencyFactor >= 0 &&
        half.efficiencyFactor <= 100_000,
    )
  );
}

export function evaluateAerobicDrift(
  source: NormalizedActivityStreams | readonly ActivityStream[],
): AerobicDriftEvaluation {
  const streams: NormalizedActivityStreams = Array.isArray(source)
    ? normalizeActivityStreams(source)
    : (source as NormalizedActivityStreams);
  const result = calculateEfficiencyFactorDecoupling(streams, { outputStream: "watts" });
  if (!result.ok) return { kind: "unavailable", reason: issueReason(result.error) };
  if (hasLongTimestampGap(streams)) {
    return { kind: "unavailable", reason: "invalid-timestamps" };
  }
  if (
    result.value.coverage.includedDurationSeconds < MINIMUM_INCLUDED_SECONDS ||
    result.value.firstHalf.durationSeconds < MINIMUM_HALF_SECONDS ||
    result.value.secondHalf.durationSeconds < MINIMUM_HALF_SECONDS
  ) {
    return { kind: "unavailable", reason: "activity-too-short" };
  }
  if (result.value.coverage.fraction < MINIMUM_COVERAGE) {
    return { kind: "unavailable", reason: "insufficient-coverage" };
  }
  const moving = streams.getUnique("moving");
  const variability = outputCoefficientOfVariation(streams);
  const limitations: ActivityAnalysisData["aerobicDrift"]["limitations"][number][] = [];
  if (result.value.coverage.includedDurationSeconds < REFERENCE_DURATION_SECONDS) {
    limitations.push("duration-under-60-minutes");
  }
  if (variability !== undefined && variability > VARIABLE_OUTPUT_CV) {
    limitations.push("variable-output");
  }
  if (!moving.ok && moving.error.kind === "MissingStream") {
    limitations.push("moving-status-unavailable");
  }
  const data: ActivityAnalysisData["aerobicDrift"] = {
    method: "local-time-weighted-efficiency-factor",
    firstHalf: {
      durationSeconds: result.value.firstHalf.durationSeconds,
      sampleCount: result.value.firstHalf.sampleCount,
      averagePowerWatts: result.value.firstHalf.outputMean,
      averageHeartRateBpm: result.value.firstHalf.heartRateMean,
      efficiencyFactor: result.value.firstHalf.efficiencyFactor,
    },
    secondHalf: {
      durationSeconds: result.value.secondHalf.durationSeconds,
      sampleCount: result.value.secondHalf.sampleCount,
      averagePowerWatts: result.value.secondHalf.outputMean,
      averageHeartRateBpm: result.value.secondHalf.heartRateMean,
      efficiencyFactor: result.value.secondHalf.efficiencyFactor,
    },
    decouplingPercent: result.value.decouplingPercent,
    coverage: result.value.coverage,
    evidence: limitations.length === 0 ? "standard" : "limited",
    limitations,
  };
  return boundedResult(data)
    ? { kind: "computed", data }
    : { kind: "unavailable", reason: "unsuitable-activity" };
}

function localDescriptors(
  channels: Readonly<Record<string, readonly (number | null)[]>>,
): readonly ActivityStream[] {
  const descriptors: ActivityStream[] = [];
  if (channels.time !== undefined) descriptors.push({ type: "time", data: [...channels.time] });
  if (channels.power !== undefined) descriptors.push({ type: "watts", data: [...channels.power] });
  if (channels.heart_rate !== undefined) {
    descriptors.push({ type: "heartrate", data: [...channels.heart_rate] });
  }
  return descriptors;
}

function canRetryFromProvider(reason: AnalysisUnavailableReason): boolean {
  return (
    reason === "missing-sensor-data" ||
    reason === "duplicate-stream" ||
    reason === "misaligned-stream" ||
    reason === "invalid-timestamps" ||
    reason === "malformed-response" ||
    reason === "response-too-large"
  );
}

function canonicalReadReason(error: unknown): AnalysisUnavailableReason {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (code === "stream_limit_exceeded") return "response-too-large";
    if (code === "stream_decode_failed" || code === "invalid_row") return "malformed-response";
  }
  return "temporary-failure";
}

export function createAerobicDriftAnalyzer(input: {
  readonly activities: Pick<CanonicalActivityReader, "getStreams">;
  readonly provider?: ProviderActivityStreamReader;
}): ActivityAnalysisSectionAnalyzer<"aerobicDrift"> {
  return Object.freeze({
    async analyze(
      request: ActivityAnalysisSectionInput,
    ): Promise<ActivityAnalysisSectionOutput<"aerobicDrift">> {
      request.signal.throwIfAborted();
      let local: AerobicDriftEvaluation;
      try {
        const streams = await input.activities.getStreams({
          id: request.activity.id,
          channels: ["time", "power", "heart_rate"],
        });
        request.signal.throwIfAborted();
        local =
          streams === undefined
            ? { kind: "unavailable", reason: "activity-not-found" }
            : evaluateAerobicDrift(localDescriptors(streams.channels));
      } catch (error) {
        request.signal.throwIfAborted();
        local = { kind: "unavailable", reason: canonicalReadReason(error) };
      }
      if (local.kind === "computed") {
        return { kind: "computed", data: local.data, source: "local-canonical" };
      }
      if (
        !canRetryFromProvider(local.reason) ||
        input.provider === undefined ||
        request.source.kind !== "resolved"
      ) {
        return local;
      }
      const provider = await input.provider.read({
        providerActivityId: request.source.providerActivityId,
        sourceRevision: request.sourceRevision,
        signal: request.signal,
      });
      if (provider.kind === "unavailable") return provider;
      const evaluated = evaluateAerobicDrift(provider.streams);
      return evaluated.kind === "computed"
        ? { kind: "computed", data: evaluated.data, source: "provider" }
        : evaluated;
    },
  });
}
