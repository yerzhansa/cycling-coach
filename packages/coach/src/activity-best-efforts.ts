import {
  BestEffortDataSchema,
  MAX_ACTIVITY_ANALYSIS_EFFORTS,
  type ActivityAnalysisData,
} from "@enduragent/coach-contract";
import { z } from "zod";
import type { BestEfforts } from "intervals-icu-api";
import type { ProviderActivityBestEffortsArchive } from "./activity-analysis-archive.js";
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

export const DEFAULT_BEST_EFFORT_DURATION_SECONDS = 5 * 60;
export const ACTIVITY_BEST_EFFORT_RESPONSE_LIMIT_BYTES = 256 * 1_024;

const ProviderEffortSchema = z
  .object({
    average: z.number().finite().nonnegative().max(100_000),
    distance: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).nullish(),
    duration: z
      .number()
      .int()
      .min(1)
      .max(7 * 86_400),
    startIndex: z.number().int().nonnegative().max(1_000_000),
    endIndex: z.number().int().nonnegative().max(1_000_000),
  })
  .passthrough()
  .refine((value) => value.startIndex <= value.endIndex, {
    path: ["endIndex"],
    message: "effort indexes are reversed",
  });

const ProviderBestEffortsSchema = z
  .object({
    efforts: z.array(ProviderEffortSchema).max(MAX_ACTIVITY_ANALYSIS_EFFORTS),
  })
  .passthrough();

export interface ProviderActivityBestEffortReader {
  read(input: {
    readonly providerActivityId: string;
    readonly sourceRevision: string;
    readonly durationSeconds: number;
    readonly signal: AbortSignal;
  }): Promise<BestEfforts>;
}

export function projectProviderBestEfforts(
  response: BestEfforts,
  durationSeconds: number,
): ActivityAnalysisData["bestEfforts"] {
  if (Array.isArray(response.efforts) && response.efforts.length > MAX_ACTIVITY_ANALYSIS_EFFORTS) {
    throw new ActivityAnalysisComputationError("response-too-large");
  }
  let parsed: z.infer<typeof ProviderBestEffortsSchema>;
  try {
    parsed = ProviderBestEffortsSchema.parse(response);
  } catch (error) {
    throw new ActivityAnalysisComputationError("malformed-response", { cause: error });
  }
  if (parsed.efforts.some((effort) => effort.duration !== durationSeconds)) {
    throw new ActivityAnalysisComputationError("malformed-response");
  }
  const identities = new Set<string>();
  for (const effort of parsed.efforts) {
    const identity = `${effort.startIndex}:${effort.endIndex}`;
    if (identities.has(identity)) {
      throw new ActivityAnalysisComputationError("malformed-response");
    }
    identities.add(identity);
  }
  const ordered = [...parsed.efforts].sort(
    (left, right) =>
      right.average - left.average ||
      left.startIndex - right.startIndex ||
      left.endIndex - right.endIndex,
  );
  try {
    return BestEffortDataSchema.parse({
      scope: {
        kind: "selected-activity",
        stream: "power",
        durationSeconds,
        tieRule: "earliest-start",
      },
      efforts: ordered.map((effort, index) => ({
        rank: index + 1,
        startIndex: effort.startIndex,
        endIndex: effort.endIndex,
        durationSeconds: effort.duration,
        distanceMeters: effort.distance ?? null,
        averageWatts: effort.average,
      })),
    });
  } catch (error) {
    throw new ActivityAnalysisComputationError("malformed-response", { cause: error });
  }
}

export function createProviderActivityBestEffortReader(input: {
  readonly access: ProviderActivityAnalysisClientAccess;
  readonly archive: ProviderActivityBestEffortsArchive;
}): ProviderActivityBestEffortReader {
  return Object.freeze({
    async read(request: {
      readonly providerActivityId: string;
      readonly sourceRevision: string;
      readonly durationSeconds: number;
      readonly signal: AbortSignal;
    }) {
      const lease = await input.access.open({
        sourceRevision: request.sourceRevision,
        signal: request.signal,
        maximumBytes: ACTIVITY_BEST_EFFORT_RESPONSE_LIMIT_BYTES,
      });
      const result = await lease.client.activities.findBestEfforts(request.providerActivityId, {
        stream: "watts",
        duration: request.durationSeconds,
        count: MAX_ACTIVITY_ANALYSIS_EFFORTS,
      });
      request.signal.throwIfAborted();
      if (!result.ok) {
        providerActivityFailure(result.error, lease.responseLimitExceeded(), request.signal);
      }
      await input.archive.write({
        sourceRevision: request.sourceRevision,
        durationSeconds: request.durationSeconds,
        response: result.value,
        signal: request.signal,
      });
      request.signal.throwIfAborted();
      return result.value;
    },
  });
}

export function createBestEffortAnalyzer(input: {
  readonly provider: ProviderActivityBestEffortReader;
  readonly durationSeconds?: number;
}): ActivityAnalysisSectionAnalyzer<"bestEfforts"> {
  const durationSeconds = input.durationSeconds ?? DEFAULT_BEST_EFFORT_DURATION_SECONDS;
  if (
    !Number.isSafeInteger(durationSeconds) ||
    durationSeconds < 1 ||
    durationSeconds > 7 * 86_400
  ) {
    throw new TypeError("best-effort duration is invalid");
  }
  return Object.freeze({
    async analyze(
      request: ActivityAnalysisSectionInput,
    ): Promise<ActivityAnalysisSectionOutput<"bestEfforts">> {
      request.signal.throwIfAborted();
      if (request.source.kind !== "resolved") {
        return { kind: "unavailable", reason: request.source.reason };
      }
      const response = await input.provider.read({
        providerActivityId: request.source.providerActivityId,
        sourceRevision: request.sourceRevision,
        durationSeconds,
        signal: request.signal,
      });
      return {
        kind: "computed",
        source: "provider",
        data: projectProviderBestEfforts(response, durationSeconds),
      };
    },
  });
}
