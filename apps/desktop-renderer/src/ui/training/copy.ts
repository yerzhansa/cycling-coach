import type {
  AnalysisRefreshFailureCode,
  AnalysisUnavailableReason,
  CyclingAnchor,
  PowerProgressComputed,
  PowerProgressRefreshFailureCode,
  PowerProgressUnavailableReason,
  TrainingContextUnknownReason,
} from "@enduragent/coach-contract";
import { PLATFORM_COPY } from "../../platform-copy";
import type { TrainingContextStatus } from "../../training-context/controller";

export const MAX_VISIBLE_PLAN_ITEMS = 7;

export const TRAINING_UNKNOWN_COPY: Readonly<Record<TrainingContextUnknownReason, string>> = {
  "not-synced": "Not synced yet",
  "missing-anchor": "No cycling FTP anchor is available",
  "no-platform-load": "No platform Load is available for the last 7 days",
  "no-plan": "No planned cycling workouts are available",
  "insufficient-data": "Not enough persisted data to show this yet",
  "no-wellness": "No wellness readings are available",
  "source-restricted": "Not enough activity data is visible to calculate this safely",
};

export const WELLNESS_LABELS: readonly string[] = ["HRV", "Sleep", "Resting HR"];

export const POWER_PROGRESS_UNAVAILABLE_COPY: Readonly<
  Record<PowerProgressUnavailableReason, string>
> = {
  "not-synced": "Sync training data to compare your recent power.",
  "insufficient-data": "Not enough power-curve data to compare two 28-day periods.",
  "invalid-data": "Power progress data could not be verified. Sync again.",
  "refresh-failed": "Power progress has not refreshed yet. Try syncing again.",
  "temporary-failure": "Power progress is temporarily unavailable. Try again.",
  "source-restricted": "Too much activity data is hidden to compare power safely.",
};

export const POWER_PROGRESS_REFRESH_FAILURE_COPY: Readonly<
  Record<PowerProgressRefreshFailureCode, string>
> = {
  "request-budget-exhausted": "The latest refresh exceeded its request budget.",
  "rate-limited": "intervals.icu delayed the latest refresh.",
  timeout: "The latest refresh timed out.",
  network: "The latest refresh lost its network connection.",
  "provider-unavailable": "intervals.icu was unavailable during the latest refresh.",
  "malformed-response": "The latest refresh returned data that could not be used.",
  "response-too-large": "The latest refresh returned more data than the app could accept.",
  cancelled: "The latest refresh was cancelled.",
  "temporary-failure": "The latest refresh did not finish.",
};

export const POWER_PROGRESS_ROTATION_COPY: Readonly<
  Record<PowerProgressComputed["rotation"], string>
> = {
  sprint: "Short efforts changed more favorably than long efforts.",
  endurance: "Long efforts changed more favorably than short efforts.",
  balanced: "Short and long efforts changed at a similar rate.",
  unknown: "Not enough comparable efforts to identify a power shift.",
};

export const POWER_PROGRESS_FRESHNESS_COPY: Readonly<
  Record<PowerProgressComputed["freshness"], string>
> = {
  fresh: "Fresh",
  flag: "Refresh due",
  stale: "Stale",
  critical: "Very stale",
};

export const RIDE_IMPORT_DESCRIPTION = PLATFORM_COPY.rideImportDescription;

export function analysisUnavailableCopy(reason: AnalysisUnavailableReason): string {
  switch (reason) {
    case "activity-not-found":
      return "This ride is no longer available in local training history.";
    case "source-not-found":
    case "not-provider-backed":
      return "This analysis requires a ride synced from intervals.icu.";
    case "ambiguous-source":
      return "More than one intervals.icu source matches this ride, so analysis is paused.";
    case "missing-sensor-data":
      return "This ride does not have both power and heart-rate data.";
    case "duplicate-stream":
      return "Duplicate sensor streams prevent a reliable comparison.";
    case "misaligned-stream":
      return "The power, heart-rate, and time streams do not line up.";
    case "invalid-timestamps":
      return "The ride timeline contains invalid timestamps or a long recording gap.";
    case "activity-too-short":
      return "At least 30 usable minutes, with 15 minutes in each half, are required.";
    case "insufficient-coverage":
      return "Less than 80% of the ride has usable power and heart-rate coverage.";
    case "unstable-output":
      return "The ride output could not support an efficiency-factor comparison.";
    case "moving-status-unavailable":
      return "The moving-status stream is present but cannot be verified.";
    case "unsuitable-activity":
      return "This ride does not meet the whole-ride analysis checks.";
    case "empty-response":
    case "malformed-response":
      return "The latest stream response could not be verified.";
    case "response-too-large":
      return "The ride streams exceed the app's private processing limit.";
    case "request-budget-exhausted":
      return "The analysis request budget has been reached for this ride.";
    case "rate-limited":
      return "intervals.icu delayed this analysis request.";
    case "timeout":
      return "The analysis request timed out.";
    case "network":
      return "The analysis request lost its network connection.";
    case "provider-unavailable":
      return "intervals.icu is unavailable for this analysis.";
    case "cancelled":
      return "The analysis request was cancelled.";
    case "unsupported":
      return "This analysis is not available in the current app version.";
    case "temporary-failure":
      return "The ride could not be analyzed right now.";
  }
}

export function analysisRefreshFailureCopy(reason: AnalysisRefreshFailureCode): string {
  switch (reason) {
    case "request-budget-exhausted":
      return "The latest refresh reached its request budget.";
    case "rate-limited":
      return "intervals.icu delayed the latest refresh.";
    case "timeout":
      return "The latest refresh timed out.";
    case "network":
      return "The latest refresh lost its network connection.";
    case "provider-unavailable":
      return "intervals.icu was unavailable during the latest refresh.";
    case "malformed-response":
      return "The latest refresh returned data that could not be verified.";
    case "response-too-large":
      return "The latest refresh exceeded the private processing limit.";
    case "cancelled":
      return "The latest refresh was cancelled.";
    case "source-changed":
      return "The ride changed while the latest refresh was running.";
    case "temporary-failure":
      return "The latest refresh did not finish.";
  }
}

export function trainingStatusCopy(status: TrainingContextStatus): string {
  if (status === "loading") return "Loading training data…";
  if (status === "unavailable") return "Training data unavailable";
  if (status === "refresh-unavailable") return "Refresh unavailable";
  return "";
}

export function stalenessCopy(band: CyclingAnchor["stalenessBand"], ageDays: number): string {
  const days = Math.floor(ageDays);
  if (band === "fresh") return "Fresh";
  if (band === "aging") return `Aging · ${days}d`;
  if (band === "stale") return `Stale · ${days}d`;
  return `Very stale · ${days}d`;
}
