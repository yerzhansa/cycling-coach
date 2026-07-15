/**
 * Reference layer — compliance and body metrics.
 *
 * Computers in this module port the metric math from the Reference layer's
 * upstream protocol. See `NOTICE.md` for license attribution.
 */

import type { Activity } from "../schemas/inputs.js";

import {
  isoDateDaysBefore,
  isoToMs,
  parseIsoMs,
} from "./date-helpers.js";
import { roundHalfEven } from "./rounding.js";
import {
  getActivities,
  getCurrentFtpIndoor,
  getCurrentFtpOutdoor,
  getFtpHistoryIndoor,
  getFtpHistoryOutdoor,
  getIntervalsLookup,
  getPastEvents,
  type MetricInput,
} from "./metric-input.js";
import { computeSeasonalContext, type SeasonalContext } from "./seasonal-context.js";

// Upstream sync.py:3553 hardcodes this 4-element subset; e-bike rides are
// deliberately excluded from consistency tracking even though they appear in
// SPORT_FAMILIES as cycling. Don't derive from SPORT_FAMILIES — the
// divergence is upstream-faithful.
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

export interface BenchmarkEmission {
  current_ftp: number | null;
  ftp_8_weeks_ago: number | null;
  benchmark_index: number | null;
  benchmark_percentage: string | null;
  seasonal_expected: boolean | null;
}

const MS_PER_DAY = 86_400_000;

// Seasonal expectations table, mirroring sync.py:3590-3596. Keyed by the
// `SeasonalContext` union (minus `Unknown`) so that the lookup is checked at
// compile time: a typo or a phase added to `SeasonalContext` without a paired
// range here becomes a TypeScript error rather than a silent `null` at the
// `seasonal_expected` emission.
const SEASONAL_EXPECTATIONS: Record<
  Exclude<SeasonalContext, "Unknown">,
  readonly [number, number]
> = {
  "Off-season / Transition": [-0.05, -0.02],
  "Early Base": [-0.02, 0.01],
  "Late Base / Build": [0.02, 0.05],
  "Build / Early Race Season": [0.01, 0.04],
  "Peak Race Season": [0.01, 0.03],
  "Late Season / Transition": [-0.03, 0.0],
};

/**
 * Benchmark Index = round((FTP_current / FTP_8_weeks_ago) - 1, 3).
 *
 * Searches `ftpHistory` for the entry whose date is closest to (today - 56d),
 * limited to a ±7d tolerance window around that target. When multiple entries
 * fall in the window, the one with the smallest |date - target| in days wins
 * (insertion-order tiebreak — first match retains, because the strict `<`
 * comparison doesn't replace on equality). Returns `(null, null)` when
 * `currentFtp` is falsy, when `ftpHistory` is empty, or when no entry sits
 * in the window.
 *
 * The day-diff measurement mirrors Python's `timedelta.days` — floor of the
 * second-difference divided by 86 400. With a frozenNow that includes a time
 * component (e.g. `2026-05-10T12:00:00`), this is asymmetric: an entry at
 * `target - 12h` has `.days == -1` (abs 1), while one at `target + 12h`
 * has `.days == 0`. Replicating that exactly is what keeps the port
 * bit-identical to the captured oracle.
 *
 * Upstream source mirrored line-by-line: `sync.py:2201-2249`
 * (`_calculate_benchmark_index`). See `NOTICE.md` for upstream attribution.
 */
export function calculateBenchmarkIndex(
  currentFtp: number | null | undefined,
  ftpHistory: Record<string, number>,
  today: string,
): { benchmarkIndex: number | null; ftp8WeeksAgo: number | null } {
  if (!currentFtp || Object.keys(ftpHistory).length === 0) {
    return { benchmarkIndex: null, ftp8WeeksAgo: null };
  }

  const todayMs = isoToMs(today);
  const targetMs = todayMs - 56 * MS_PER_DAY;
  const earliestMs = targetMs - 7 * MS_PER_DAY;
  const latestMs = targetMs + 7 * MS_PER_DAY;

  let bestDateKey: string | null = null;
  let bestDiff = Number.POSITIVE_INFINITY;

  for (const dateStr of Object.keys(ftpHistory)) {
    const entryMs = parseIsoMs(dateStr);
    if (entryMs === null) continue;
    if (entryMs < earliestMs || entryMs > latestMs) continue;
    const diff = Math.abs(Math.floor((entryMs - targetMs) / MS_PER_DAY));
    if (diff < bestDiff) {
      bestDiff = diff;
      bestDateKey = dateStr;
    }
  }

  if (bestDateKey !== null) {
    const ftp8WeeksAgo = ftpHistory[bestDateKey];
    const benchmarkIndex = roundHalfEven(currentFtp / ftp8WeeksAgo - 1, 3);
    return { benchmarkIndex, ftp8WeeksAgo };
  }

  return { benchmarkIndex: null, ftp8WeeksAgo: null };
}

/**
 * Returns whether the benchmark index falls inside the per-phase expected
 * range. Both endpoints are inclusive. Returns `null` when the index is
 * `null` or when the seasonal context string is not in the expectations
 * table (the defensive `"Unknown"` branch falls through here).
 *
 * Upstream source mirrored line-by-line: `sync.py:3582-3603`
 * (`_is_benchmark_expected`). See `NOTICE.md` for upstream attribution.
 */
export function isBenchmarkExpected(
  benchmarkIndex: number | null,
  seasonalContext: SeasonalContext,
): boolean | null {
  if (benchmarkIndex === null) return null;
  if (seasonalContext === "Unknown") return null;
  const [low, high] = SEASONAL_EXPECTATIONS[seasonalContext];
  return low <= benchmarkIndex && benchmarkIndex <= high;
}

/**
 * Replicates Python's `f"{x:+.1%}"` format: multiply by 100, format with an
 * explicit sign and exactly one decimal place, append `%`. Negative zero
 * keeps its `-` sign (Python distinguishes `-0.0` from `0.0` in this
 * specifier), so the check uses `Object.is(pct, -0)` rather than `<`.
 */
export function formatBenchmarkPercentage(benchmarkIndex: number): string {
  const pct = roundHalfEven(benchmarkIndex * 100, 1);
  const negative = pct < 0 || Object.is(pct, -0);
  const sign = negative ? "-" : "+";
  const magnitudeStr = Math.abs(pct).toFixed(1);
  return `${sign}${magnitudeStr}%`;
}

/**
 * Indoor benchmark emission. Five keys, mirroring `sync.py:3422-3428`:
 *   - `current_ftp`: the indoor FTP from settings (None when absent).
 *   - `ftp_8_weeks_ago`: the FTP value at the best-matched history entry.
 *   - `benchmark_index`: change ratio rounded to 3 dp.
 *   - `benchmark_percentage`: `:+.1%` string when index is non-null.
 *   - `seasonal_expected`: whether the index sits in the per-phase range.
 *
 * Today is sourced from `input.frozenNow` so the 56-day target and ±7d
 * tolerance window track the captured oracle's clock. Seasonal context
 * is computed from the same `frozenNow`, keeping the two metrics in
 * lockstep with whatever month the fixture pins.
 */
export function computeBenchmarkIndoor(input: MetricInput): BenchmarkEmission {
  const currentFtp = getCurrentFtpIndoor(input);
  const ftpHistory = getFtpHistoryIndoor(input);
  const { benchmarkIndex, ftp8WeeksAgo } = calculateBenchmarkIndex(
    currentFtp,
    ftpHistory,
    input.frozenNow,
  );
  const seasonalContext = computeSeasonalContext(input);
  const seasonalExpected = isBenchmarkExpected(benchmarkIndex, seasonalContext);

  return {
    current_ftp: currentFtp,
    ftp_8_weeks_ago: ftp8WeeksAgo,
    benchmark_index: benchmarkIndex,
    benchmark_percentage:
      benchmarkIndex === null
        ? null
        : formatBenchmarkPercentage(benchmarkIndex),
    seasonal_expected: seasonalExpected,
  };
}

/**
 * Per-activity v3.106 has-intervals emission. Each entry is `true` only when
 * the activity's lookup entry exists AND carries at least one segment with
 * `type === "WORK"`. RECOVERY-only placeholders, empty interval lists,
 * activities absent from the lookup, and lookup entries missing the
 * `intervals` key all return `false`. v3.105 flagged any non-empty intervals
 * list as structured; the v3.106 fix narrows to WORK segments so
 * intervals.icu's whole-session RECOVERY placeholder on unstructured
 * endurance rides no longer misclassifies them.
 *
 * Keys are stringified `activity.id` (mirroring `str(act.get("id"))` at
 * `sync.py:7870`) and sorted ascending as strings to lock JSON key-order
 * across Pyodide / CPython / Node.
 *
 * Upstream source mirrored line-by-line: `sync.py:7866-7873` inside
 * `_format_activities`; v3.106 changelog entry at `sync.py:133` documents
 * the regression fix. This Reference-port hoists the predicate into a
 * standalone derived map so the parity gate can assert it without
 * exposing the whole formatted-activity dict.
 */
export function computeHasIntervals(
  input: MetricInput,
): Record<string, boolean> {
  const intervalsLookup = getIntervalsLookup(input);
  const activities = getActivities(input);

  const flagByActivityId: Record<string, boolean> = {};
  for (const activity of activities) {
    const key = String(activity.id);
    const segments = intervalsLookup[key]?.intervals ?? [];
    flagByActivityId[key] = segments.some((s) => s.type === "WORK");
  }

  const sorted: Record<string, boolean> = {};
  for (const key of Object.keys(flagByActivityId).sort()) {
    sorted[key] = flagByActivityId[key]!;
  }
  return sorted;
}

export type EffortResponseVerdict = "positive" | "neutral" | "negative";

/**
 * Classify one activity's RPE against the protocol's expected band for its
 * normalized intensity. Returns `"positive"` when the reported RPE undershoots
 * the band (fitness / freshness tell), `"negative"` when it overshoots
 * (fatigue / under-recovery tell), `"neutral"` inside the band, and `null`
 * outside the classifier's coverage range.
 *
 * `intensityPct` is the per-activity intensity stored as a percentage
 * (0–100+), matching upstream's `icu_intensity`; the function normalizes to a
 * decimal before bucketing. `rpe` is the 1–10 reported value. The Intensity<0.65
 * null branch is a deliberate design gap, not missing-data handling —
 * recovery rides and aborted sessions fall outside the bands' calibration
 * range and fabricating a band there would produce noise on the sessions
 * least worth flagging.
 *
 * Band edges (0.65 / 0.75 / 0.85 / 0.95 / 1.05) are protocol-invented per
 * the Reference protocol v11.43 §RPE Expectation Bands, not derived from
 * peer-reviewed literature — this is a faithful port of an upstream-defined
 * classifier. Future readers should not expect a Borg / Foster / Bandura
 * citation; the only authority is the upstream protocol spec.
 *
 * Upstream source mirrored line-by-line: `sync.py:3493-3534`
 * (`_classify_effort_response`), per the Reference protocol v11.43 §RPE
 * Expectation Bands docstring at `sync.py:3500`. See `NOTICE.md` for
 * upstream attribution.
 */
export function classifyEffortResponse(
  intensityPct: number | null | undefined,
  rpe: number | null | undefined,
): EffortResponseVerdict | null {
  if (intensityPct == null || rpe == null || rpe <= 0) return null;
  const ifDecimal = intensityPct / 100;
  if (ifDecimal < 0.65) return null;

  let bandLow: number;
  let bandHigh: number;
  if (ifDecimal < 0.75) {
    bandLow = 2;
    bandHigh = 4;
  } else if (ifDecimal < 0.85) {
    bandLow = 4;
    bandHigh = 6;
  } else if (ifDecimal < 0.95) {
    bandLow = 6;
    bandHigh = 8;
  } else if (ifDecimal < 1.05) {
    bandLow = 8;
    bandHigh = 9;
  } else {
    bandLow = 9;
    bandHigh = 10;
  }

  if (rpe < bandLow) return "positive";
  if (rpe > bandHigh) return "negative";
  return "neutral";
}

/**
 * Per-activity v3.105 effort-response classification. Iterates the fixture's
 * activities, applies `classifyEffortResponse` to each `(icu_intensity,
 * icu_rpe)` pair, and emits a per-activity-id map with keys sorted ascending
 * as strings.
 *
 * `icu_rpe` is read via a narrow cast on the activity row — the upstream
 * Activity schema (`z.looseObject`) preserves unknown fields through the
 * boundary, and the predicate is the only consumer of `icu_rpe` today.
 * Matches `act.get("icu_rpe")` in `sync.py:7859`.
 *
 * Upstream emission point mirrored: `sync.py:7858-7860` inside
 * `_format_activities`. As with `has_intervals`, this Reference-port hoists
 * the per-activity field into a standalone derived map so the parity gate
 * can assert it without ingesting the full formatted-activity dict.
 */
export function computeEffortResponseSignal(
  input: MetricInput,
): Record<string, EffortResponseVerdict | null> {
  const activities = getActivities(input);

  const verdictByActivityId: Record<string, EffortResponseVerdict | null> = {};
  for (const activity of activities) {
    const key = String(activity.id);
    const intensity = activity.icu_intensity ?? null;
    const rpe = activity.icu_rpe ?? null;
    verdictByActivityId[key] = classifyEffortResponse(intensity, rpe);
  }

  const sorted: Record<string, EffortResponseVerdict | null> = {};
  for (const key of Object.keys(verdictByActivityId).sort()) {
    sorted[key] = verdictByActivityId[key]!;
  }
  return sorted;
}

/**
 * Outdoor benchmark emission. Five keys, mirroring `sync.py:3430-3436` —
 * identical shape and semantics to the indoor branch, just sourced from
 * the outdoor FTP and the outdoor slice of `ftp_history`. Upstream calls
 * the same `_calculate_benchmark_index` helper at `sync.py:2434` with
 * `current_ftp_outdoor` and `ftp_history.get("outdoor", {})`; the
 * shared `calculateBenchmarkIndex` + `isBenchmarkExpected` helpers
 * therefore apply unchanged.
 */
export function computeBenchmarkOutdoor(input: MetricInput): BenchmarkEmission {
  const currentFtp = getCurrentFtpOutdoor(input);
  const ftpHistory = getFtpHistoryOutdoor(input);
  const { benchmarkIndex, ftp8WeeksAgo } = calculateBenchmarkIndex(
    currentFtp,
    ftpHistory,
    input.frozenNow,
  );
  const seasonalContext = computeSeasonalContext(input);
  const seasonalExpected = isBenchmarkExpected(benchmarkIndex, seasonalContext);

  return {
    current_ftp: currentFtp,
    ftp_8_weeks_ago: ftp8WeeksAgo,
    benchmark_index: benchmarkIndex,
    benchmark_percentage:
      benchmarkIndex === null
        ? null
        : formatBenchmarkPercentage(benchmarkIndex),
    seasonal_expected: seasonalExpected,
  };
}

