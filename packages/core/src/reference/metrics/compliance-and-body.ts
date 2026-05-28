/**
 * Reference layer — compliance and body metrics.
 *
 * Computers in this module port the metric math from the Reference layer's
 * upstream protocol. See `NOTICE.md` for license attribution.
 */

import type { Activity } from "../schemas/inputs.js";

import { roundHalfEven } from "./rounding.js";
import {
  getActivities,
  getPastEvents,
  type MetricInput,
} from "./metric-input.js";

const CYCLING_TYPES = new Set([
  "Ride",
  "VirtualRide",
  "MountainBikeRide",
  "GravelRide",
]);

export interface ConsistencyDetailsEmpty {
  planned_days: 0;
  completed_days: number;
  matched_days: 0;
  note: "No planned workouts in period";
}

export interface ConsistencyDetailsPopulated {
  planned_days: number;
  completed_days: number;
  matched_days: number;
  planned_dates: string[];
  completed_dates: string[];
}

export type ConsistencyDetails =
  | ConsistencyDetailsEmpty
  | ConsistencyDetailsPopulated;

export interface ConsistencyAndDetails {
  index: number | null;
  details: ConsistencyDetails;
}

/**
 * Consistency Index = matched-day count / planned-day count, matched on
 * calendar date (so a day with multiple planned workouts counts once and
 * any cycling activity on a planned day satisfies it).
 *
 * Planned dates are pulled from `past_events` whose `category` is
 * `"WORKOUT"`. Completed dates are pulled from cycling activities only —
 * the canonical Ride / VirtualRide / MountainBikeRide / GravelRide
 * type set. Multi-sport athletes' run/swim sessions are deliberately
 * excluded from the completed set; the upstream comment frames this as
 * "fair comparison" because the planned-workout side is assumed
 * cycling-led. Date strings are the first 10 characters of
 * `start_date_local`, i.e. `YYYY-MM-DD`.
 *
 * Two emission shapes share the function (the upstream returns a tuple):
 *
 *   - empty planned set → `(null, { planned_days: 0, completed_days, matched_days: 0, note })`.
 *     The note literal is "No planned workouts in period". Date lists
 *     are deliberately absent in this branch.
 *   - non-empty planned set → `(round(matched / planned, 2), { ...counts, planned_dates, completed_dates })`.
 *     Date lists are sorted ascending. The note key is deliberately
 *     absent.
 *
 * The round is half-to-even (banker's rounding) to mirror Python's
 * `round()` behaviour bit-identically.
 *
 * Upstream source mirrored line-by-line: `sync.py:3536-3580`
 * (`_calculate_consistency_index`) plus the emission dict at
 * `sync.py:3412-3413`. See `NOTICE.md` for upstream attribution.
 */
function consistencyAndDetails(input: MetricInput): ConsistencyAndDetails {
  // The snapshot harness passes `activities_for_consistency=activities_7d`,
  // mirroring the upstream's live caller at `sync.py:2561` which feeds the
  // 7-day display window. The function itself does not re-window — it trusts
  // the caller's slice — so the parity port pre-slices here.
  const activities7d = sliceTrailing7d(getActivities(input), input.frozenNow);
  const pastEvents = getPastEvents(input);

  const plannedDates = new Set<string>();
  for (const event of pastEvents) {
    if (event.category === "WORKOUT") {
      const dateStr = (event.start_date_local ?? "").slice(0, 10);
      if (dateStr) plannedDates.add(dateStr);
    }
  }

  const completedDates = new Set<string>();
  for (const activity of activities7d) {
    if (CYCLING_TYPES.has(activity.type)) {
      const dateStr = (activity.start_date_local ?? "").slice(0, 10);
      if (dateStr) completedDates.add(dateStr);
    }
  }

  if (plannedDates.size === 0) {
    return {
      index: null,
      details: {
        planned_days: 0,
        completed_days: completedDates.size,
        matched_days: 0,
        note: "No planned workouts in period",
      },
    };
  }

  let matchedCount = 0;
  for (const d of plannedDates) {
    if (completedDates.has(d)) matchedCount += 1;
  }

  const index = roundHalfEven(matchedCount / plannedDates.size, 2);

  return {
    index,
    details: {
      planned_days: plannedDates.size,
      completed_days: completedDates.size,
      matched_days: matchedCount,
      planned_dates: [...plannedDates].sort(),
      completed_dates: [...completedDates].sort(),
    },
  };
}

export function computeConsistencyIndex(input: MetricInput): number | null {
  return consistencyAndDetails(input).index;
}

export function computeConsistencyDetails(
  input: MetricInput,
): ConsistencyDetails {
  return consistencyAndDetails(input).details;
}

// Trailing 7-day window: rows whose `start_date_local` date falls in
// [frozenNow-6, frozenNow] inclusive, by lexicographic comparison on the
// YYYY-MM-DD prefix. Mirrors the harness slice for `activities_7d`.
function sliceTrailing7d(activities: Activity[], frozenNow: string): Activity[] {
  const today = frozenNow.slice(0, 10);
  const oldest = isoDateDaysBefore(frozenNow, 6);
  return activities.filter((a) => {
    if (typeof a.start_date_local !== "string") return false;
    const d = a.start_date_local.slice(0, 10);
    return oldest <= d && d <= today;
  });
}

function isoDateDaysBefore(isoNow: string, daysBefore: number): string {
  const [y, m, d] = isoNow.slice(0, 10).split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const utc = new Date(Date.UTC(y, m - 1, d));
  utc.setUTCDate(utc.getUTCDate() - daysBefore);
  const yy = utc.getUTCFullYear();
  const mm = String(utc.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(utc.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}
