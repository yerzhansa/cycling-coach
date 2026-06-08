/**
 * Step 7 (SOFT): record cross-signal inconsistencies as warnings. Maps to the
 * upstream protocol's multi-metric conflict check. Never hard-fails. See
 * `NOTICE.md` for license attribution.
 */
import type { FetchedReference } from "../../sync/run-sync.js";
import type { CheckResult, GateWarning } from "../sync-gate.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function checkMultiMetricConflict(fetched: FetchedReference): CheckResult {
  const warnings: GateWarning[] = [];

  const profile = asRecord(fetched?.latest?.athlete_profile);
  const quickStats = profile === null ? null : asRecord(profile.quick_stats);

  const weeklyHours = quickStats === null ? null : num(quickStats.weekly_hours);
  const weeklyLoad = quickStats === null ? null : num(quickStats.weekly_load);
  if (weeklyHours !== null && weeklyLoad !== null && weeklyHours > 0 && weeklyLoad === 0) {
    warnings.push({
      step: "step7_multi_metric_conflict",
      detail: `weekly_hours=${weeklyHours} but weekly_load=0`,
    });
  }

  const activities = fetched?.latest?.recent_activities;
  const activitiesCount = quickStats === null ? null : num(quickStats.activities_count);
  if (
    Array.isArray(activities) &&
    activities.length > 0 &&
    activitiesCount !== null &&
    activitiesCount === 0
  ) {
    warnings.push({
      step: "step7_multi_metric_conflict",
      detail: `recent_activities=${activities.length} but activities_count=0`,
    });
  }

  return { failures: [], warnings };
}
