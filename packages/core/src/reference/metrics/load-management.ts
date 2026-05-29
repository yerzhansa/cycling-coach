/**
 * Reference layer — load-management metrics.
 *
 * Computers in this module port the metric math from the Reference layer's
 * upstream protocol. See `NOTICE.md` for license attribution.
 */

import type { Activity, WellnessDay } from "../schemas/inputs.js";

import { isoDateDaysBefore } from "./date-helpers.js";
import { getActivities, type MetricInput } from "./metric-input.js";
import { roundHalfEven } from "./rounding.js";
import { SPORT_FAMILIES } from "./sport-families.js";
import { mean, pythonSum, sampleStdev } from "./statistics.js";

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
  const activities = getActivities(input);

  const dailyLoad7d = getDailyLoad(activities, 7, input.frozenNow);
  const dailyLoad28d = getDailyLoad(activities, 28, input.frozenNow);

  const load7dTotal = pythonSum(dailyLoad7d);
  const load28dTotal = pythonSum(dailyLoad28d);

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
  const activities = getActivities(input);

  const dailyLoad7d = getDailyLoad(activities, 7, input.frozenNow);

  if (dailyLoad7d.length <= 1 || !dailyLoad7d.some((d) => d !== 0)) {
    return null;
  }

  const meanLoad = mean(dailyLoad7d);
  const stdevLoad = sampleStdev(dailyLoad7d);
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
  const activities = getActivities(input);

  const dailyLoadBySport = getDailyLoadBySport(activities, 7, input.frozenNow);
  if (dailyLoadBySport.size === 0) return null;

  let primaryDays: number[] | undefined;
  let maxTotal = -Infinity;
  for (const days of dailyLoadBySport.values()) {
    const total = pythonSum(days);
    if (total > maxTotal) {
      maxTotal = total;
      primaryDays = days;
    }
  }
  if (primaryDays === undefined) return null;

  let activeDays = 0;
  for (const d of primaryDays) if (d > 0) activeDays += 1;
  if (activeDays < 3 || primaryDays.length <= 1) return null;

  const meanLoad = mean(primaryDays);
  const stdevLoad = sampleStdev(primaryDays);
  if (stdevLoad <= 0) return null;

  return roundHalfEven(meanLoad / stdevLoad, 2);
}

/**
 * Effective monotony — the selector that picks between total and
 * primary-sport monotony for downstream alert thresholds.
 *
 * Multi-sport athletes' total monotony can be inflated by a consistent
 * cross-training Load floor; the primary-sport variant isolates the
 * dominant modality. This selector switches to the primary-sport value
 * when (a) more than one sport family appeared in the 7-day window AND
 * (b) the primary-sport computation produced a non-null result.
 * Otherwise falls through to total monotony (which itself may be null).
 *
 * Pure composition — no new math. Calls the sibling compute functions
 * for the two candidate values and the shared per-sport aggregator for
 * the multi-sport check. The `isMultiSport` branch selector shares the
 * same derivation as `computeMultiSportDetected`. The duplicate
 * aggregation work (getDailyLoad runs three times across this call's
 * transitive helpers) is intentional:
 * the discipline rewards line-by-line transliteration over optimization,
 * and the snapshot gate would catch any drift from a structural rewrite.
 *
 * Upstream source mirrored line-by-line: `sync.py:3081-3082` inside
 * `_calculate_derived_metrics`. The `daily_tss_by_sport` Python local
 * is the same map produced by the per-sport aggregation helper at
 * `sync.py:3646-3675`. See `NOTICE.md` for upstream attribution.
 *
 * Return shape is the raw upstream output (number or null), not a
 * discriminated-union envelope. Raw compute functions feed the parity
 * gate; a sibling envelope wrapper will feed the curator when the
 * curator integration lands.
 */
export function computeEffectiveMonotony(input: MetricInput): number | null {
  const activities = getActivities(input);

  const dailyLoadBySport = getDailyLoadBySport(activities, 7, input.frozenNow);
  const isMultiSport = dailyLoadBySport.size > 1;

  const primarySportMonotony = computePrimarySportMonotony(input);
  const monotony = computeMonotony(input);

  return isMultiSport && primarySportMonotony !== null
    ? primarySportMonotony
    : monotony;
}

/**
 * `multi_sport_detected` — whether the trailing-7-day window spans more than
 * one sport family by accumulated Load. This is the SAME `is_multi_sport`
 * derivation `computeEffectiveMonotony` uses for its branch selector
 * (`getDailyLoadBySport(...).size > 1`); the two share one definition so the
 * runtime indicator and the monotony selector can never disagree.
 *
 * Upstream source mirrored line-by-line: `sync.py:3081`
 * (`is_multi_sport = len(daily_tss_by_sport) > 1`), emitted at `sync.py:3368`.
 * See `NOTICE.md` for upstream attribution.
 */
export function computeMultiSportDetected(input: MetricInput): boolean {
  const activities = getActivities(input);
  return getDailyLoadBySport(activities, 7, input.frozenNow).size > 1;
}

/**
 * Training strain (Foster 1998).
 *
 * Strain = weekly Load × total monotony, where weekly Load is the sum of
 * the trailing 7-day daily-Load series (the aggregator ACWR and monotony
 * share) and monotony is the already-rounded total monotony. Foster
 * associates strain above ~3500-4000 with overtraining.
 *
 * Returns `null` whenever monotony is falsy — `null` (the empty/rest-week
 * cascade) or `0`. This mirrors the upstream `if monotony else None`
 * guard, so an Unknown monotony cascades to an Unknown strain.
 *
 * Otherwise returns `round(weeklyLoad × monotony, 0)` with half-to-even
 * rounding to mirror Python's `round()` bit-identically.
 *
 * Upstream source mirrored line-by-line: `sync.py:3087`
 * (`_calculate_derived_metrics`). `tss_7d_total` is the sum of the 7-day
 * series from the daily aggregator at `sync.py:3629-3644`, shared with
 * ACWR and monotony. See `NOTICE.md` for upstream attribution.
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
export function computeStrain(input: MetricInput): number | null {
  const monotony = computeMonotony(input);
  if (!monotony) return null;

  const activities = getActivities(input);
  const dailyLoad7d = getDailyLoad(activities, 7, input.frozenNow);
  const load7dTotal = pythonSum(dailyLoad7d);

  return roundHalfEven(load7dTotal * monotony, 0);
}

/**
 * Stress tolerance — strain normalised by monotony, scaled to a 0-100
 * reference band.
 *
 *   stressTolerance = (strain / monotony) / 100
 *
 * Both inputs are the already-rounded total-monotony quantities the
 * strain metric uses: `strain` is `round(weeklyLoad × monotony, 0)` and
 * `monotony` is `round(mean / stdev, 2)`. Because `strain` carries the
 * `monotony` factor, the ratio collapses to roughly `weeklyLoad / 100`,
 * but the upstream computes it from the two rounded locals — so the
 * port does too, rather than short-cutting to weekly Load. The result
 * is rounded half-to-even to 1 decimal.
 *
 * Returns `null` whenever `strain` or `monotony` is falsy (`null` from
 * the empty/rest-week cascade, or `0`), mirroring the upstream
 * `if strain and monotony else None` guard — so an Unknown monotony
 * cascades through Unknown strain to an Unknown stress tolerance.
 *
 * Upstream source mirrored line-by-line: `sync.py:3131`
 * (`_calculate_derived_metrics`). `strain` and `monotony` are the locals
 * at `sync.py:3087` and `sync.py:3037`, both built from the daily
 * aggregator at `sync.py:3629-3644` shared with ACWR. See `NOTICE.md`
 * for upstream attribution.
 *
 * Mirrors `sync.py:3131` line-by-line per the deviation registry's
 * `stress_tolerance` `approved-revert` entry in
 * `tools/intentional-deviations.yaml` (the capacity-cap family proposed
 * in an earlier spec revision was reviewed and reverted; ADR-0015 is
 * superseded).
 *
 * Return shape is the raw upstream output (number or null), not a
 * discriminated-union envelope. Raw compute functions feed the parity
 * gate; a sibling envelope wrapper will feed the curator when the
 * curator integration lands.
 */
export function computeStressTolerance(input: MetricInput): number | null {
  const strain = computeStrain(input);
  const monotony = computeMonotony(input);
  if (!strain || !monotony) return null;

  return roundHalfEven(strain / monotony / 100, 1);
}

/**
 * Monotony interpretation band — the human-readable verdict on monotony,
 * multi-sport aware.
 *
 * Reads the three already-computed monotony quantities — total monotony,
 * effective monotony (the selector that prefers primary-sport monotony
 * when multi-sport is detected), and the multi-sport flag (more than one
 * sport family in the trailing 7-day window). The band is driven by
 * effective monotony against a single threshold of 2.0:
 *
 *   - effective monotony Unknown ⇒ Unknown (cascades from monotony),
 *   - multi-sport inflation (multi-sport AND total monotony truthy AND
 *     effective < total) ⇒ an annotated string naming both values, with
 *     "elevated"/"normal" chosen by effective > 2.0,
 *   - otherwise ⇒ the bare "elevated"/"normal", chosen by effective > 2.0.
 *
 * Upstream source mirrored line-by-line: `sync.py:3473-3491`
 * (`_interpret_monotony`). The three inputs are the call-site locals at
 * `sync.py:3362-3363` — `monotony` (computeMonotony), `effective_monotony`
 * (computeEffectiveMonotony), and `is_multi_sport`
 * (`len(daily_tss_by_sport) > 1`, sync.py:3081). See `NOTICE.md` for
 * upstream attribution.
 *
 * Return shape is the raw upstream output (string or null), not a
 * discriminated-union envelope. Raw compute functions feed the parity
 * gate; a sibling envelope wrapper will feed the curator when the
 * curator integration lands.
 *
 * @see Foster, C. (1998). Monitoring training in athletes with reference
 *      to overtraining syndrome. Med Sci Sports Exerc 30(7):1164-1168.
 *      DOI: 10.1097/00005768-199807000-00023
 */
export function computeMonotonyInterpretation(input: MetricInput): string | null {
  const totalMonotony = computeMonotony(input);
  const effectiveMonotony = computeEffectiveMonotony(input);

  const activities = getActivities(input);
  const isMultiSport = getDailyLoadBySport(activities, 7, input.frozenNow).size > 1;

  if (effectiveMonotony === null) return null;
  if (isMultiSport && totalMonotony && effectiveMonotony < totalMonotony) {
    if (effectiveMonotony > 2.0) {
      return `elevated (primary sport ${pyFloatStr(effectiveMonotony)}, total ${pyFloatStr(totalMonotony)} inflated by multi-sport)`;
    }
    return `normal (primary sport ${pyFloatStr(effectiveMonotony)}, total ${pyFloatStr(totalMonotony)} inflated by multi-sport)`;
  }
  if (effectiveMonotony > 2.0) return "elevated";
  return "normal";
}

/**
 * Recovery index — the morning HRV/RHR readiness ratio.
 *
 * Reads the trailing 7-day wellness window (today and the six prior
 * calendar days, in fixture order) and forms a two-contributor ratio:
 * the day's HRV relative to its 7-day baseline, divided by the day's
 * resting HR relative to its 7-day baseline. Above 1.0 reads as good
 * recovery, below 1.0 as suppressed.
 *
 *   ri = (latestHrv / hrvBaseline7d) / (latestRhr / rhrBaseline7d)
 *
 * Baselines are the mean of the in-window readings, rounded to 1
 * decimal: HRV readings filtered to the physiological band (10-250ms
 * RMSSD, sensor-error rejection), resting-HR readings filtered to
 * truthy values. "Latest" is the last reading in the window (HRV gated
 * by the same validity band, resting HR taken raw). Returns `null` when
 * any of the two latest readings or two baselines is missing or zero,
 * mirroring the upstream truthiness guard — so an empty or wellness-free
 * window cascades to Unknown.
 *
 * Upstream source mirrored line-by-line: `sync.py:3089-3115`
 * (`_calculate_derived_metrics`) — the 7-day baseline block plus the
 * recovery-index ratio — and the validity band at `sync.py:6225-6231`
 * (`_is_valid_hrv`). The 7-day window matches the harness call-site slice
 * (`wellness_7d`); see `NOTICE.md` for upstream attribution.
 *
 * Two-contributor, 7-day-baseline shape per the deviation registry's
 * `recovery_index` `approved-revert` entry in
 * `tools/intentional-deviations.yaml` (the 28-day / 4-contributor
 * z-score variant was reviewed and rejected for lack of literature).
 *
 * Return shape is the raw upstream output (number or null), not a
 * discriminated-union envelope. Raw compute functions feed the parity
 * gate; a sibling envelope wrapper will feed the curator when the
 * curator integration lands.
 */
export function computeRecoveryIndex(input: MetricInput): number | null {
  const wellness7d = getWellnessWindow(input, 7);

  const hrvValues7d = wellness7d
    .map((w) => w.hrv)
    .filter((v): v is number => isValidHrv(v));
  const rhrValues7d = wellness7d
    .map((w) => w.restingHR)
    .filter((v): v is number => !!v);

  const hrvBaseline7d =
    hrvValues7d.length > 0 ? roundHalfEven(mean(hrvValues7d), 1) : null;
  const rhrBaseline7d =
    rhrValues7d.length > 0 ? roundHalfEven(mean(rhrValues7d), 1) : null;

  const latest = wellness7d.length > 0 ? wellness7d[wellness7d.length - 1]! : null;
  const latestHrvRaw = latest ? latest.hrv : null;
  const latestHrv = isValidHrv(latestHrvRaw) ? latestHrvRaw : null;
  const latestRhr = latest ? latest.restingHR : null;

  if (latestHrv && latestRhr && hrvBaseline7d && rhrBaseline7d) {
    const hrvRatio = latestHrv / hrvBaseline7d;
    const rhrRatio = latestRhr / rhrBaseline7d;
    return rhrRatio > 0 ? roundHalfEven(hrvRatio / rhrRatio, 2) : null;
  }
  return null;
}

/**
 * Load-recovery ratio — weekly Load weighed against autonomic recovery.
 *
 *   loadRecoveryRatio = weeklyLoad / (recoveryIndex × 100)
 *
 * The numerator is the sum of the trailing 7-day daily-Load series (the
 * aggregator ACWR, monotony, and strain share). The denominator is the
 * recovery index — the morning HRV/RHR readiness ratio — scaled by 100,
 * so a healthier autonomic signal shrinks the ratio. The result is
 * rounded half-to-even to 1 decimal.
 *
 * Returns `null` whenever the recovery index is falsy (`null` from the
 * empty/wellness-free cascade, or `0`) or non-positive, mirroring the
 * upstream `if ri and ri > 0 else None` guard — so an Unknown recovery
 * index cascades to an Unknown load-recovery ratio.
 *
 * Upstream source mirrored line-by-line: `sync.py:3135`
 * (`_calculate_derived_metrics`). `tss_7d_total` is the sum of the 7-day
 * series from the daily aggregator at `sync.py:3629-3644`, shared with
 * ACWR; `ri` is the recovery-index local at `sync.py:3113`. See
 * `NOTICE.md` for upstream attribution.
 *
 * Mirrors `sync.py:3135` line-by-line per the deviation registry's
 * `load_recovery_ratio` `approved-revert` entry in
 * `tools/intentional-deviations.yaml` (the time-proxy-denominator family
 * proposed in an earlier spec revision was reviewed and reverted for lack
 * of literature).
 *
 * Return shape is the raw upstream output (number or null), not a
 * discriminated-union envelope. Raw compute functions feed the parity
 * gate; a sibling envelope wrapper will feed the curator when the
 * curator integration lands.
 */
export function computeLoadRecoveryRatio(input: MetricInput): number | null {
  const ri = computeRecoveryIndex(input);
  if (!ri || ri <= 0) return null;

  const activities = getActivities(input);
  const dailyLoad7d = getDailyLoad(activities, 7, input.frozenNow);
  const load7dTotal = pythonSum(dailyLoad7d);

  return roundHalfEven(load7dTotal / (ri * 100), 1);
}

// Mirrors `_is_valid_hrv` at sync.py:6225-6231: rejects null and
// out-of-band readings (valid RMSSD is 10-250ms), filtering sensor
// errors while preserving legitimate elite-athlete highs.
function isValidHrv(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && value >= 10 && value <= 250;
}

// The 7-day wellness window the upstream reads as `wellness_7d`: rows
// whose `id` date falls in [frozenNow-(days-1), frozenNow], inclusive,
// in fixture order. Mirrors the harness `_within(_wellness_all, "id",
// ...)` slice — the inclusive lexicographic date comparison and the
// preserved input order matter, because the recovery index reads the
// LAST row of this list (`wellness_7d[-1]`), not the chronologically
// latest. Fixtures are trusted at the gate boundary (Zod ran upstream
// of snapshot capture), matching the `getActivities` cast.
function getWellnessWindow(input: MetricInput, days: number): WellnessDay[] {
  const wellness = input.fixture.wellness;
  const oldest = isoDateDaysBefore(input.frozenNow, days - 1);
  const today = input.frozenNow.slice(0, 10);
  return wellness.filter((w) => {
    if (typeof w.id !== "string") return false;
    const d = w.id.slice(0, 10);
    return oldest <= d && d <= today;
  });
}

// Python's f-string interpolates a float via str(), which renders an
// integer-valued float with a trailing ".0" (str(2.0) == "2.0"); JS
// String(2.0) drops it ("2"). The monotony inputs here are round(_, 2)
// floats, so the only divergence from shortest-round-trip repr — shared
// by both runtimes — is that integer case. Reproduce Python's rendering
// so an integer-valued monotony interpolates bit-identically.
function pyFloatStr(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : `${value}`;
}

function getDailyLoad(
  activities: Activity[],
  days: number,
  frozenNow: string,
): number[] {
  const dailyLoad = new Map<string, number>();
  for (const act of activities) {
    // The load aggregators run over raw, unwindowed activities, so a
    // non-string start_date_local reaches here (the distribution path is
    // pre-filtered by getActivitiesInWindow and never sees one). The oracle's
    // window filter drops such rows; bucketing them under "" is equivalent —
    // the result array only ever reads real dates — and avoids throwing on
    // malformed fixture input. Mirrors the guard in selectPrimarySport.
    const dateStr =
      typeof act.start_date_local === "string" ? act.start_date_local.slice(0, 10) : "";
    // `|| 0` maps a hypothetical NaN load to 0; the upstream `or 0` keeps NaN.
    // Unreachable: z.number() rejects NaN at the schema boundary.
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
    // `|| 0` maps a hypothetical NaN load to 0 (skipped); the upstream `or 0`
    // keeps NaN. Unreachable: z.number() rejects NaN at the schema boundary.
    const load = act.icu_training_load || 0;
    if (load <= 0) continue;
    // Guarded like getDailyLoad: a non-string date buckets to "", which is
    // never a window date, so the row is dropped — matching the oracle.
    const dateStr =
      typeof act.start_date_local === "string" ? act.start_date_local.slice(0, 10) : "";
    if (!windowDates.has(dateStr)) continue;
    // Object.hasOwn guards against prototype-chain lookups: a fixture
    // with act.type === "toString" / "constructor" / "__proto__" would
    // otherwise resolve to an inherited Function reference (truthy, so
    // `?? "other"` does not fire) and pollute the bySport key set.
    const sportFamily = Object.hasOwn(SPORT_FAMILIES, act.type)
      ? SPORT_FAMILIES[act.type]
      : "other";
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
