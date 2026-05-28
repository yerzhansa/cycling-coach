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
  getCurrentFtpIndoor,
  getCurrentFtpOutdoor,
  getFtpHistoryIndoor,
  getFtpHistoryOutdoor,
  getPastEvents,
  type MetricInput,
} from "./metric-input.js";
import { computeSeasonalContext, type SeasonalContext } from "./seasonal-context.js";

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
    const entryMs = parseIsoDateMidnightMs(dateStr);
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

function isoToMs(iso: string): number {
  // Parse 'YYYY-MM-DDTHH:MM:SS' (or 'YYYY-MM-DD') as a UTC instant. Both
  // sides of the window comparison go through this helper, so the choice
  // of zone is internal — what matters is that the wall-clock offset
  // between a frozenNow datetime and a date-only history entry mirrors
  // Python's naive-datetime subtraction.
  const datePart = iso.slice(0, 10);
  const timePart = iso.length >= 19 ? iso.slice(11, 19) : "00:00:00";
  const [y, m, d] = datePart.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const [hh, mm, ss] = timePart.split(":").map(Number) as [
    number,
    number,
    number,
  ];
  return Date.UTC(y, m - 1, d, hh, mm, ss);
}

function parseIsoDateMidnightMs(dateStr: string): number | null {
  // sync.py:2221 wraps the strptime in try/except; malformed entries are
  // skipped silently. Mirror that here — anything that isn't strict
  // YYYY-MM-DD with a calendar-real month/day is dropped. The round-trip
  // check is load-bearing: `Date.UTC(2026, 1, 30)` silently normalises to
  // 2026-03-02, but `datetime.strptime("2026-02-30", "%Y-%m-%d")` raises
  // and the upstream `except` skips the entry. Without the check, a
  // calendar-invalid history key would slip into the ±7d window with the
  // wrong timestamp and break parity.
  if (typeof dateStr !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) return null;
  const y = Number(match[1]);
  const mo = Number(match[2]);
  const d = Number(match[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (
    back.getUTCFullYear() !== y ||
    back.getUTCMonth() + 1 !== mo ||
    back.getUTCDate() !== d
  ) {
    return null;
  }
  return ms;
}
