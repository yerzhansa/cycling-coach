/**
 * Reference layer — load-management metrics.
 *
 * Computers in this module port the metric math from the Reference layer's
 * upstream protocol. See `NOTICE.md` for license attribution.
 */

import type { Activity } from "../schemas/inputs.js";

import type { MetricInput } from "./metric-input.js";

/**
 * Acute:Chronic Workload Ratio (Gabbett 2016).
 *
 * Acute load = mean daily Load over the trailing 7 days (today and the
 * six prior days). Chronic load = mean daily Load over the trailing 28
 * days. Days with no activity contribute 0; the denominator is the
 * calendar window length, not the count of active days.
 *
 * Returns `round(acute / chronic, 2)` when chronic > 0, else `null`. The
 * round is half-to-even (banker's rounding) to mirror Python's `round()`
 * behaviour bit-identically.
 *
 * Upstream source mirrored line-by-line: `sync.py:3023-3028`
 * (`_calculate_derived_metrics`) plus the per-day aggregation helper at
 * `sync.py:3629-3644` (the daily-load aggregator). See `NOTICE.md` for
 * upstream attribution.
 *
 * Return shape is the raw upstream output (number or null), not a
 * discriminated-union envelope. Raw compute functions feed the parity
 * gate; a sibling envelope wrapper will feed the curator when the
 * curator integration lands.
 *
 * @see Gabbett, T.J. (2016). The training-injury prevention paradox:
 *      should athletes be training smarter and harder?
 *      Br J Sports Med 50(5):273-280. DOI: 10.1136/bjsports-2015-095788
 */
export function computeAcwr(input: MetricInput): number | null {
  const fixture = input.fixture as { activities?: Activity[] };
  const activities = fixture.activities ?? [];

  const dailyLoad7d = getDailyLoad(activities, 7, input.frozenNow);
  const dailyLoad28d = getDailyLoad(activities, 28, input.frozenNow);

  const load7dTotal = dailyLoad7d.reduce((s, t) => s + t, 0);
  const load28dTotal = dailyLoad28d.reduce((s, t) => s + t, 0);

  const acuteLoad = load7dTotal ? load7dTotal / 7 : 0;
  const chronicLoad = load28dTotal ? load28dTotal / 28 : 0;

  if (chronicLoad <= 0) return null;
  return roundHalfEven(acuteLoad / chronicLoad, 2);
}

/**
 * Training monotony (Foster 1998).
 *
 * Monotony = mean(dailyLoad) / sampleStdev(dailyLoad) over the trailing
 * 7 days (today and the six prior). The aggregator is the same one
 * ACWR uses — calendar-window length, days with no activity contribute 0.
 *
 * Returns `null` when:
 *   - fewer than 2 daily values are available (cannot happen for the
 *     fixed 7-day window, but the Python guards it),
 *   - every day's Load is 0 (rest week / empty fixture),
 *   - the sample standard deviation is 0 (constant non-zero series).
 *
 * Otherwise returns `round(mean / stdev, 2)` with half-to-even rounding
 * to mirror Python's `round()` bit-identically.
 *
 * Upstream source mirrored line-by-line: `sync.py:3030-3041`
 * (`_calculate_derived_metrics`). The daily aggregator at
 * `sync.py:3629-3644` is shared with ACWR. See `NOTICE.md` for upstream
 * attribution.
 *
 * Return shape is the raw upstream output (number or null), not a
 * discriminated-union envelope. Raw compute functions feed the parity
 * gate; a sibling envelope wrapper will feed the curator when the
 * curator integration lands.
 *
 * @see Foster, C. (1998). Monitoring training in athletes with reference
 *      to overtraining syndrome. Med Sci Sports Exerc 30(7):1164-1168.
 *      DOI: 10.1097/00005768-199807000-00023
 */
export function computeMonotony(input: MetricInput): number | null {
  const fixture = input.fixture as { activities?: Activity[] };
  const activities = fixture.activities ?? [];

  const dailyLoad7d = getDailyLoad(activities, 7, input.frozenNow);

  if (dailyLoad7d.length <= 1 || !dailyLoad7d.some((d) => d !== 0)) {
    return null;
  }

  const meanLoad = arithmeticMean(dailyLoad7d);
  const stdevLoad = sampleStdev(dailyLoad7d, meanLoad);
  if (stdevLoad <= 0) return null;

  return roundHalfEven(meanLoad / stdevLoad, 2);
}

/**
 * Primary-sport monotony — Foster monotony restricted to the trailing
 * 7-day series for the highest-Load sport family.
 *
 * Multi-sport athletes get inflated total monotony when cross-training
 * adds a consistent Load floor across days. Restricting the series to
 * one modality isolates the actual load variation. Primary-sport
 * selection ties break on insertion order (first sport encountered in
 * the fixture wins) — see `getDailyLoadBySport` for why.
 *
 * Returns `null` when:
 *   - no activity with Load > 0 falls in the window (the per-sport map
 *     is empty),
 *   - the primary sport has fewer than 3 active days (Foster's signal
 *     needs at least 3 non-zero observations to be meaningful),
 *   - the primary sport's daily series has length ≤ 1 (cannot happen
 *     for the fixed 7-day window, but the Python guards it),
 *   - the sample standard deviation of the primary sport's daily series
 *     is 0 (constant non-zero series).
 *
 * Otherwise returns `round(mean / stdev, 2)` with half-to-even rounding
 * to mirror Python's `round()` bit-identically.
 *
 * Upstream source mirrored line-by-line: `sync.py:3044-3076`
 * (`_calculate_derived_metrics`) plus the per-sport aggregation helper
 * at `sync.py:3646-3675` (`_get_daily_tss_by_sport`) and the sport-family
 * lookup at `sync.py:290-308` (`SPORT_FAMILIES`). The 7-day window
 * pre-filter mirrors the call-site filter at `sync.py:2337-2338`. See
 * `NOTICE.md` for upstream attribution.
 *
 * Return shape is the raw upstream output (number or null), not a
 * discriminated-union envelope. Raw compute functions feed the parity
 * gate; a sibling envelope wrapper will feed the curator when the
 * curator integration lands.
 *
 * @see Foster, C. (1998). Monitoring training in athletes with reference
 *      to overtraining syndrome. Med Sci Sports Exerc 30(7):1164-1168.
 *      DOI: 10.1097/00005768-199807000-00023
 */
export function computePrimarySportMonotony(input: MetricInput): number | null {
  const fixture = input.fixture as { activities?: Activity[] };
  const activities = fixture.activities ?? [];

  const dailyLoadBySport = getDailyLoadBySport(activities, 7, input.frozenNow);
  if (dailyLoadBySport.size === 0) return null;

  let primaryDays: number[] | undefined;
  let maxTotal = -Infinity;
  for (const days of dailyLoadBySport.values()) {
    let total = 0;
    for (const d of days) total += d;
    if (total > maxTotal) {
      maxTotal = total;
      primaryDays = days;
    }
  }
  if (primaryDays === undefined) return null;

  let activeDays = 0;
  for (const d of primaryDays) if (d > 0) activeDays += 1;
  if (activeDays < 3 || primaryDays.length <= 1) return null;

  const meanLoad = arithmeticMean(primaryDays);
  const stdevLoad = sampleStdev(primaryDays, meanLoad);
  if (stdevLoad <= 0) return null;

  return roundHalfEven(meanLoad / stdevLoad, 2);
}

// Mirrors `SPORT_FAMILIES` at sync.py:290-308. Unmapped types fall
// through to "other" at the lookup site.
const SPORT_FAMILIES: Record<string, string> = {
  Ride: "cycling",
  VirtualRide: "cycling",
  MountainBikeRide: "cycling",
  GravelRide: "cycling",
  EBikeRide: "cycling",
  VirtualSki: "ski",
  NordicSki: "ski",
  Walk: "walk",
  Hike: "walk",
  Run: "run",
  VirtualRun: "run",
  TrailRun: "run",
  Swim: "swim",
  Rowing: "rowing",
  WeightTraining: "strength",
  Yoga: "other",
  Workout: "other",
};

function arithmeticMean(values: number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total / values.length;
}

// Python `statistics.stdev` uses the numerically stable two-pass
// `sum((x-c)**2) - sum(x-c)**2 / n` correction so the residual mean
// drift cancels out. Mirror the same accumulation order so the float
// result matches bit-for-bit on inputs that aren't exactly centered on
// the recomputed mean.
function sampleStdev(values: number[], xbar: number): number {
  const n = values.length;
  let total = 0;
  let total2 = 0;
  for (const x of values) {
    const d = x - xbar;
    total += d * d;
    total2 += d;
  }
  const ss = total - (total2 * total2) / n;
  return Math.sqrt(ss / (n - 1));
}

function getDailyLoad(
  activities: Activity[],
  days: number,
  frozenNow: string,
): number[] {
  const dailyLoad = new Map<string, number>();
  for (const act of activities) {
    const dateStr = act.start_date_local.slice(0, 10);
    const load = act.icu_training_load || 0;
    dailyLoad.set(dateStr, (dailyLoad.get(dateStr) ?? 0) + load);
  }
  const result: number[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = isoDateDaysBefore(frozenNow, i);
    result.push(dailyLoad.get(date) ?? 0);
  }
  return result;
}

// Map insertion order matches the order each sport family is first
// encountered while iterating `activities`. Python `defaultdict` exhibits
// the same property, and `max(dict, key=dict.get)` returns the first key
// with the maximum value when scanning insertion order — so preserving
// this order is what keeps primary-sport tiebreaks bit-identical.
function getDailyLoadBySport(
  activities: Activity[],
  days: number,
  frozenNow: string,
): Map<string, number[]> {
  const windowDates = new Set<string>();
  for (let i = days - 1; i >= 0; i--) {
    windowDates.add(isoDateDaysBefore(frozenNow, i));
  }

  const bySport = new Map<string, Map<string, number>>();
  for (const act of activities) {
    const load = act.icu_training_load || 0;
    if (load <= 0) continue;
    const dateStr = act.start_date_local.slice(0, 10);
    if (!windowDates.has(dateStr)) continue;
    const sportFamily = SPORT_FAMILIES[act.type] ?? "other";
    let dailyMap = bySport.get(sportFamily);
    if (dailyMap === undefined) {
      dailyMap = new Map<string, number>();
      bySport.set(sportFamily, dailyMap);
    }
    dailyMap.set(dateStr, (dailyMap.get(dateStr) ?? 0) + load);
  }

  const result = new Map<string, number[]>();
  for (const [sport, dailyMap] of bySport) {
    const dailyArray: number[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = isoDateDaysBefore(frozenNow, i);
      dailyArray.push(dailyMap.get(date) ?? 0);
    }
    result.set(sport, dailyArray);
  }
  return result;
}

function isoDateDaysBefore(isoNow: string, daysBefore: number): string {
  const datePart = isoNow.slice(0, 10);
  const [y, m, d] = datePart.split("-").map(Number) as [number, number, number];
  const utc = new Date(Date.UTC(y, m - 1, d));
  utc.setUTCDate(utc.getUTCDate() - daysBefore);
  return utc.toISOString().slice(0, 10);
}

// Python's `round(x, n)` uses banker's rounding (round-half-to-even) and
// diverges from `Math.round(x*10**n)/10**n` (round-half-up) for values
// exactly at the half boundary. Mirroring Python keeps the gate
// bit-identical on any future ACWR value that lands at the boundary.
function roundHalfEven(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const scaled = value * factor;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  const epsilon = 1e-9;
  if (diff < 0.5 - epsilon) return floor / factor;
  if (diff > 0.5 + epsilon) return (floor + 1) / factor;
  return (floor % 2 === 0 ? floor : floor + 1) / factor;
}
