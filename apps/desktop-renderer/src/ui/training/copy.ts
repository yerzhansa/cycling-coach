import type { CyclingAnchor, TrainingContextUnknownReason } from "@enduragent/coach-contract";
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
