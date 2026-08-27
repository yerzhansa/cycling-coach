import { estimateCriticalPower } from "@enduragent/kernel/reference/metrics";
import type { SustainabilityFamilyCurves } from "@enduragent/kernel/reference/schemas";

export interface CyclingEstimatedCpEffort {
  readonly activityId: string;
  readonly ride: string;
  readonly date: string;
  readonly durationS: number;
  readonly averagePowerW: number;
  readonly device: string;
}

export type CyclingEstimatedCpProjection =
  | {
      readonly status: "available" | "stale";
      readonly watts: number;
      readonly calculatedOn: string;
      readonly lastSuccessfulSyncAtMs: number | null;
      readonly unavailableReason: null;
      readonly efforts: [CyclingEstimatedCpEffort, CyclingEstimatedCpEffort];
    }
  | {
      readonly status: "unavailable";
      readonly watts: null;
      readonly calculatedOn: null;
      readonly lastSuccessfulSyncAtMs: number | null;
      readonly unavailableReason: "missing-effort" | "mathematically-invalid";
      readonly efforts: [];
    };

interface Candidate extends CyclingEstimatedCpEffort {
  readonly startedAt: string;
}

function device(value: {
  readonly power_meter?: string | null;
  readonly device_name?: string | null;
}): string | null {
  for (const candidate of [value.power_meter, value.device_name]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
  }
  return null;
}

function candidates(
  curves: SustainabilityFamilyCurves | undefined,
  minDurationS: number,
  maxDurationS: number,
): readonly Candidate[] {
  if (curves === undefined) return [];
  const result: Candidate[] = [];
  for (const envelope of Object.values(curves.power)) {
    const activities = envelope.activities ?? {};
    for (const curve of envelope.list) {
      if (
        curve.secs.length !== curve.watts.length ||
        curve.activity_ids === undefined ||
        curve.activity_ids.length !== curve.secs.length
      )
        continue;
      for (let index = 0; index < curve.secs.length; index += 1) {
        const durationS = curve.secs[index];
        const averagePowerW = curve.watts[index];
        const activityId = curve.activity_ids[index];
        if (
          !Number.isSafeInteger(durationS) ||
          durationS < minDurationS ||
          durationS > maxDurationS ||
          typeof averagePowerW !== "number" ||
          !Number.isFinite(averagePowerW) ||
          averagePowerW <= 0 ||
          typeof activityId !== "string" ||
          activityId.length === 0
        )
          continue;
        const activity = activities[activityId];
        if (
          activity === undefined ||
          activity.device_watts !== true ||
          activity.icu_ignore_power === true ||
          activity.missing_timestamps === true ||
          activity.missing_power_samples === true
        )
          continue;
        const powerDevice = device(activity);
        const date = activity.start_date_local.slice(0, 10);
        if (powerDevice === null || !/^\d{4}-\d{2}-\d{2}$/u.test(date)) continue;
        const ride =
          typeof activity.name === "string" && activity.name.trim().length > 0
            ? activity.name.trim()
            : typeof activity.type === "string" && activity.type.trim().length > 0
              ? activity.type.trim()
              : "Ride";
        result.push({
          activityId,
          ride,
          date,
          startedAt: activity.start_date_local,
          durationS,
          averagePowerW,
          device: powerDevice,
        });
      }
    }
  }
  return result;
}

function best(values: readonly Candidate[]): Candidate | null {
  return (
    [...values].sort(
      (left, right) =>
        right.averagePowerW - left.averagePowerW ||
        right.startedAt.localeCompare(left.startedAt) ||
        right.durationS - left.durationS ||
        left.activityId.localeCompare(right.activityId),
    )[0] ?? null
  );
}

function evidence(candidate: Candidate): CyclingEstimatedCpEffort {
  return {
    activityId: candidate.activityId,
    ride: candidate.ride,
    date: candidate.date,
    durationS: candidate.durationS,
    averagePowerW: candidate.averagePowerW,
    device: candidate.device,
  };
}

export function projectCyclingEstimatedCp(input: {
  readonly curves: SustainabilityFamilyCurves | undefined;
  readonly calculatedOn: string;
  readonly lastSuccessfulSyncAtMs: number | null;
  readonly stale: boolean;
}): CyclingEstimatedCpProjection {
  const short = best(candidates(input.curves, 120, 200));
  const long = best(candidates(input.curves, 720, 1_200));
  if (short === null || long === null) {
    return {
      status: "unavailable",
      watts: null,
      calculatedOn: null,
      lastSuccessfulSyncAtMs: input.lastSuccessfulSyncAtMs,
      unavailableReason: "missing-effort",
      efforts: [],
    };
  }
  const estimate = estimateCriticalPower({ short, long });
  if (estimate.status === "unavailable") {
    return {
      status: "unavailable",
      watts: null,
      calculatedOn: null,
      lastSuccessfulSyncAtMs: input.lastSuccessfulSyncAtMs,
      unavailableReason: estimate.reason,
      efforts: [],
    };
  }
  return {
    status: input.stale ? "stale" : "available",
    watts: Math.round(estimate.cpWatts),
    calculatedOn: input.calculatedOn,
    lastSuccessfulSyncAtMs: input.lastSuccessfulSyncAtMs,
    unavailableReason: null,
    efforts: [evidence(short), evidence(long)],
  };
}
