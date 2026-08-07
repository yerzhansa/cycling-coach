import type {
  CyclingAnchor,
  PowerProgressComputed,
  PowerProgressRefreshFailureCode,
  PowerProgressUnavailableReason,
  TrainingContextUnknownReason,
} from "@enduragent/coach-contract";
import type { TrainingContextStatus } from "../../training-context/controller.js";

export const MAX_VISIBLE_PLAN_ITEMS = 7;

export const TRAINING_UNKNOWN_COPY: Readonly<Record<TrainingContextUnknownReason, string>> = {
  "not-synced": "Not synced yet",
  "missing-anchor": "No cycling FTP anchor is available",
  "no-platform-load": "No platform Load is available for the last 7 days",
  "no-plan": "No planned cycling workouts are available",
  "insufficient-data": "Not enough persisted data to show this yet",
  "no-wellness": "No wellness readings are available",
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

export const RIDE_IMPORT_DESCRIPTION =
  "Add FIT, TCX or GPX files from this Mac. You can also drop them onto the window.";

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
