/**
 * Step 2 (HARD): the trailing-7-day activity-duration sum agrees with the
 * profile's reported weekly hours within tolerance. Maps to the upstream
 * protocol's weekly-hours consistency check. See `NOTICE.md` for license
 * attribution.
 */
import type { FetchedReference } from "../../sync/run-sync.js";
import type { CheckResult } from "../sync-gate.js";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const RELATIVE_TOLERANCE = 0.01;
/** When reported weekly hours is zero, allow a few minutes of noise before failing. */
const ABS_FLOOR_HOURS = 0.05;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function parseDateMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function checkWeeklyHours(fetched: FetchedReference): CheckResult {
  const profile = asRecord(fetched?.latest?.athlete_profile);
  const quickStats = profile === null ? null : asRecord(profile.quick_stats);
  const weeklyHours =
    quickStats !== null && typeof quickStats.weekly_hours === "number"
      ? quickStats.weekly_hours
      : null;

  const activities = fetched?.latest?.recent_activities;
  if (weeklyHours === null || !Array.isArray(activities) || activities.length === 0) {
    return { failures: [], warnings: [] };
  }

  const dated = activities
    .map((a) => {
      const r = asRecord(a);
      if (r === null) return null;
      const ms = parseDateMs(r.start_date_local);
      const movingTime = typeof r.moving_time === "number" ? r.moving_time : null;
      if (ms === null || movingTime === null) return null;
      return { ms, movingTime };
    })
    .filter((x): x is { ms: number; movingTime: number } => x !== null);

  if (dated.length === 0) return { failures: [], warnings: [] };

  const newest = Math.max(...dated.map((d) => d.ms));
  const actualSecs = dated
    .filter((d) => newest - d.ms <= SEVEN_DAYS_MS)
    .reduce((sum, d) => sum + d.movingTime, 0);
  const actualHours = actualSecs / 3600;

  if (weeklyHours === 0) {
    if (actualHours <= ABS_FLOOR_HOURS) return { failures: [], warnings: [] };
    return {
      failures: [
        {
          step: "step2_weekly_hours_consistency",
          detail: `weekly hours mismatch: expected 0h actual ${actualHours}h (above floor ${ABS_FLOOR_HOURS}h)`,
        },
      ],
      warnings: [],
    };
  }

  const relErr = Math.abs(actualHours - weeklyHours) / weeklyHours;
  if (relErr <= RELATIVE_TOLERANCE) return { failures: [], warnings: [] };

  return {
    failures: [
      {
        step: "step2_weekly_hours_consistency",
        detail: `weekly hours mismatch: expected ${weeklyHours}h actual ${actualHours}h (relErr ${relErr})`,
      },
    ],
    warnings: [],
  };
}
