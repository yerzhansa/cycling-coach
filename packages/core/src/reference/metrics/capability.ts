/**
 * Capability metrics — the per-athlete adaptation signals the upstream
 * emits under the `capability` dict. Each sub-key is ported as its own
 * compute function and registered as `capability.<sub>` so the parity
 * gate asserts it as a one-metric-one-file oracle (the snapshot harness
 * explodes the upstream's nested `capability` dict into sibling files).
 *
 * Raw compute functions return the upstream output shape (object or
 * null), not a discriminated-union envelope — they feed the parity gate.
 *
 * See `NOTICE.md` for upstream attribution.
 */

import { isoDateDaysBefore } from "./date-helpers.js";
import {
  getActivities,
  getActivitiesInWindow,
  getHrCurves,
  getPowerCurves,
  type MetricInput,
} from "./metric-input.js";
import { computeSeilerTid, computeSeilerTid28d, type SeilerTid } from "./distribution.js";
import { mean, pythonSum } from "./statistics.js";
import { roundHalfEven } from "./rounding.js";
import type { Activity, HrCurveData, PowerCurveData } from "../schemas/inputs.js";

export interface DurabilitySignal {
  mean_decoupling_7d: number | null;
  mean_decoupling_28d: number | null;
  high_drift_count_7d: number;
  high_drift_count_28d: number;
  qualifying_sessions_7d: number;
  qualifying_sessions_28d: number;
  trend: "improving" | "declining" | "stable" | null;
  reliability_limited: boolean;
  reliability_note: string | null;
  note: string;
}

export interface EfficiencyFactorSignal {
  mean_ef_7d: number | null;
  mean_ef_28d: number | null;
  qualifying_sessions_7d: number;
  qualifying_sessions_28d: number;
  trend: "improving" | "declining" | "stable" | null;
  note: string;
}

// Steady-state-session decoupling values from a window. Qualifying =
// decoupling present, variability index in (0, 1.05], moving_time ≥ 90 min.
// Mirrors the nested `_filter_qualifying` at sync.py:4061-4078. The raw API
// field `icu_hr_decoupling` is preferred; `decoupling` is the fallback name.
function filterQualifying(activities: Activity[]): number[] {
  const qualifying: number[] = [];
  for (const act of activities) {
    let dec = act.icu_hr_decoupling;
    if (dec === null || dec === undefined) dec = act.decoupling;
    const vi = act.icu_variability_index;
    const mt = act.moving_time || 0;

    if (
      dec !== null &&
      dec !== undefined &&
      vi !== null &&
      vi !== undefined &&
      vi > 0 &&
      vi <= 1.05 &&
      mt >= 5400
    ) {
      qualifying.push(dec);
    }
  }
  return qualifying;
}

// Cycling activity types EF is restricted to. Mirrors the CYCLING_TYPES set
// at sync.py:4161.
const CYCLING_TYPES = new Set(["Ride", "VirtualRide", "MountainBikeRide", "GravelRide"]);

// Steady-state-session efficiency-factor values from a window. Qualifying =
// EF present, a cycling type, variability index in (0, 1.05], moving_time >=
// 20 min. Mirrors the nested _filter_qualifying at sync.py:4163-4179.
function filterQualifyingEf(activities: Activity[]): number[] {
  const qualifying: number[] = [];
  for (const act of activities) {
    const ef = act.icu_efficiency_factor;
    const vi = act.icu_variability_index;
    const mt = act.moving_time || 0;

    if (
      ef !== null &&
      ef !== undefined &&
      CYCLING_TYPES.has(act.type) &&
      vi !== null &&
      vi !== undefined &&
      vi > 0 &&
      vi <= 1.05 &&
      mt >= 1200
    ) {
      qualifying.push(ef);
    }
  }
  return qualifying;
}

/**
 * Durability — aggregate cardiac decoupling across qualifying steady-state
 * power sessions, as a 7d-vs-28d trend. Negative decoupling indicates HR
 * drifted down relative to power (strong durability or cooling).
 *
 * Means need ≥2 qualifying sessions; the trend needs both windows. The
 * reliability gate flags alert-suppression (alarm needs N28≥5; the
 * declining warning needs N7≥3 AND N28≥5) while still surfacing the mean
 * for situational awareness.
 *
 * Upstream source mirrored line-by-line: `sync.py:4041-4136`
 * (`_calculate_durability`) plus the nested `_filter_qualifying` helper at
 * `sync.py:4061-4078`. The 7d/28d activity windows mirror the harness
 * `slice_window` calls. See `NOTICE.md` for upstream attribution.
 *
 * @see Maunder, E. et al. (2021). The importance of 'durability' in the
 *      physiological profiling of endurance athletes. Sports Med 51:1619-1628.
 *      DOI: 10.1007/s40279-021-01459-0
 */
export function computeDurability(input: MetricInput): DurabilitySignal {
  const activities = getActivities(input);
  const vals7d = filterQualifying(getActivitiesInWindow(activities, 7, input.frozenNow));
  const vals28d = filterQualifying(getActivitiesInWindow(activities, 28, input.frozenNow));

  const mean7d = vals7d.length >= 2 ? roundHalfEven(mean(vals7d), 2) : null;
  const mean28d = vals28d.length >= 2 ? roundHalfEven(mean(vals28d), 2) : null;

  const highDrift7d = vals7d.filter((v) => v > 5.0).length;
  const highDrift28d = vals28d.filter((v) => v > 5.0).length;

  let trend: DurabilitySignal["trend"] = null;
  if (mean7d !== null && mean28d !== null) {
    const delta = mean7d - mean28d;
    if (delta < -1.0) trend = "improving";
    else if (delta > 1.0) trend = "declining";
    else trend = "stable";
  }

  const n7 = vals7d.length;
  const n28 = vals28d.length;
  const reliabilityLimited = n28 < 5 || n7 < 3;
  const reliabilityNote = reliabilityLimited
    ? `insufficient qualifying sessions for alert evaluation: 7d N=${n7} (min 3), 28d N=${n28} (min 5)`
    : null;

  return {
    mean_decoupling_7d: mean7d,
    mean_decoupling_28d: mean28d,
    high_drift_count_7d: highDrift7d,
    high_drift_count_28d: highDrift28d,
    qualifying_sessions_7d: n7,
    qualifying_sessions_28d: n28,
    trend,
    reliability_limited: reliabilityLimited,
    reliability_note: reliabilityNote,
    note:
      "Steady-state power sessions only (VI <= 1.05, VI > 0, >= 90min, power data). " +
      "Negative decoupling = strong durability. Trend compares 7d vs 28d mean " +
      "(+/-1% = stable). Alerts require N28>=5 (alarm) or N7>=3 AND N28>=5 " +
      "(declining warning) for statistical reliability.",
  };
}

/**
 * Efficiency Factor — aggregate EF across qualifying steady-state cycling
 * sessions, as a 7d-vs-28d trend. EF is a power-to-heart-rate efficiency
 * ratio (intervals.icu supplies it per activity as icu_efficiency_factor);
 * rising EF at a given intensity indicates improving aerobic fitness, and
 * because EF varies with intensity the trend compares like-for-like windows.
 *
 * Means need >= 2 qualifying sessions; the trend needs both windows and uses
 * a +/-0.03 dead-band around the 7d-minus-28d delta.
 *
 * Upstream source mirrored line-by-line: sync.py:4138-4214
 * (_calculate_efficiency_factor) plus the nested _filter_qualifying helper at
 * sync.py:4163-4179. The 7d/28d activity windows mirror the harness
 * slice_window calls. See NOTICE.md for upstream attribution.
 */
export function computeEfficiencyFactor(input: MetricInput): EfficiencyFactorSignal {
  const activities = getActivities(input);
  const vals7d = filterQualifyingEf(getActivitiesInWindow(activities, 7, input.frozenNow));
  const vals28d = filterQualifyingEf(getActivitiesInWindow(activities, 28, input.frozenNow));

  const mean7d = vals7d.length >= 2 ? roundHalfEven(mean(vals7d), 2) : null;
  const mean28d = vals28d.length >= 2 ? roundHalfEven(mean(vals28d), 2) : null;

  let trend: EfficiencyFactorSignal["trend"] = null;
  if (mean7d !== null && mean28d !== null) {
    const delta = mean7d - mean28d;
    if (delta > 0.03) trend = "improving";
    else if (delta < -0.03) trend = "declining";
    else trend = "stable";
  }

  return {
    mean_ef_7d: mean7d,
    mean_ef_28d: mean28d,
    qualifying_sessions_7d: vals7d.length,
    qualifying_sessions_28d: vals28d.length,
    trend,
    note:
      "Steady-state cycling sessions only (VI <= 1.05, VI > 0, >= 20min, power+HR data). " +
      "Rising EF = improving aerobic efficiency. Compare like-for-like sessions only — " +
      "EF varies with intensity. Trend compares 7d vs 28d mean (+/-0.03 = stable).",
  };
}

export interface HrrcSignal {
  mean_hrrc_7d: number | null;
  mean_hrrc_28d: number | null;
  qualifying_sessions_7d: number;
  qualifying_sessions_28d: number;
  trend: "improving" | "declining" | "stable" | null;
  note: string;
}

// Heart-rate-recovery values from a window. Qualifying = HRRc present, plain
// number or object value/hrr payload, and > 0. Mirrors the nested
// _filter_qualifying at sync.py:4217-4232.
function filterQualifyingHrrc(activities: Activity[]): number[] {
  const qualifying: number[] = [];
  for (const act of activities) {
    let hrrc = act.icu_hrr;
    if (hrrc === null || hrrc === undefined) continue;
    if (typeof hrrc === "object") {
      let v = hrrc.value;
      if (v === null || v === undefined) v = hrrc.hrr;
      hrrc = v;
    }
    if (typeof hrrc === "number" && hrrc > 0) {
      qualifying.push(hrrc);
    }
  }
  return qualifying;
}

/**
 * HRRc — aggregate heart-rate recovery across qualifying sessions, as a
 * 7d-vs-28d trend.
 *
 * The 7d mean needs >= 1 qualifying session; the 28d mean needs >= 3
 * qualifying sessions. The trend needs both windows and uses a +/-10%
 * dead-band around the proportional 7d-vs-28d difference.
 *
 * Upstream source mirrored line-by-line: sync.py:4216-4295
 * (_calculate_hrrc_trend) plus the nested _filter_qualifying helper at
 * sync.py:4217-4232. The 7d/28d activity windows mirror the harness
 * slice_window calls. See NOTICE.md for upstream attribution.
 */
export function computeHrrc(input: MetricInput): HrrcSignal {
  const activities = getActivities(input);
  const vals7d = filterQualifyingHrrc(getActivitiesInWindow(activities, 7, input.frozenNow));
  const vals28d = filterQualifyingHrrc(getActivitiesInWindow(activities, 28, input.frozenNow));

  const mean7d = vals7d.length >= 1 ? roundHalfEven(mean(vals7d), 1) : null;
  const mean28d = vals28d.length >= 3 ? roundHalfEven(mean(vals28d), 1) : null;

  let trend: HrrcSignal["trend"] = null;
  if (mean7d !== null && mean28d !== null && mean28d > 0) {
    const pctChange = (mean7d - mean28d) / mean28d;
    if (pctChange > 0.10) trend = "improving";
    else if (pctChange < -0.10) trend = "declining";
    else trend = "stable";
  }

  return {
    mean_hrrc_7d: mean7d,
    mean_hrrc_28d: mean28d,
    qualifying_sessions_7d: vals7d.length,
    qualifying_sessions_28d: vals28d.length,
    trend,
    note:
      "HRRc = heart rate recovery (largest 60s HR drop in bpm after exceeding threshold HR for >1 min). " +
      "Higher = better parasympathetic recovery. Null when threshold not reached, recording stopped " +
      "before cooldown, or no HR data. Trend: 7d mean vs 28d mean, >10% = meaningful " +
      "(min 1 session/7d, 3 sessions/28d). Display only — not wired into readiness_decision signals.",
  };
}

export interface TidComparisonSignal {
  classification_7d: string | null;
  classification_28d: string | null;
  pi_7d: number | null;
  pi_28d: number | null;
  pi_delta: number | null;
  drift: "consistent" | "shifting" | "acute_depolarization" | null;
  note: string;
}

const TID_COMPARISON_NOTE_INSUFFICIENT =
  "Compares 7d vs 28d Seiler TID to detect distribution shifts. Insufficient data in one or both windows.";
const TID_COMPARISON_NOTE_FULL =
  "Compares 7d vs 28d Seiler TID to detect distribution shifts. pi_delta positive = more polarized acutely.";

export function compareTid(
  seiler7d: Pick<SeilerTid, "classification" | "polarization_index">,
  seiler28d: Pick<SeilerTid, "classification" | "polarization_index">,
): TidComparisonSignal {
  const cls7d = seiler7d.classification;
  const cls28d = seiler28d.classification;
  const pi7d = seiler7d.polarization_index;
  const pi28d = seiler28d.polarization_index;

  if (cls7d === null || cls28d === null) {
    return {
      classification_7d: cls7d,
      classification_28d: cls28d,
      pi_7d: pi7d,
      pi_28d: pi28d,
      pi_delta: null,
      drift: null,
      note: TID_COMPARISON_NOTE_INSUFFICIENT,
    };
  }

  let piDelta: number | null = null;
  if (pi7d !== null && pi28d !== null) {
    piDelta = roundHalfEven(pi7d - pi28d, 2);
  }

  let drift: TidComparisonSignal["drift"];
  if (pi7d !== null && pi28d !== null && pi7d < 2.0 && pi28d >= 2.0) {
    drift = "acute_depolarization";
  } else if (cls7d !== cls28d) {
    drift = "shifting";
  } else {
    drift = "consistent";
  }

  return {
    classification_7d: cls7d,
    classification_28d: cls28d,
    pi_7d: pi7d,
    pi_28d: pi28d,
    pi_delta: piDelta,
    drift,
    note: TID_COMPARISON_NOTE_FULL,
  };
}

/**
 * TID comparison — acute-vs-chronic Seiler distribution drift.
 *
 * Purely composes the all-sport 7d and 28d Seiler outputs and mirrors the
 * upstream call site at `sync.py:3199` into the comparator ported from
 * `sync.py:5094-5154`. See `NOTICE.md` for upstream attribution.
 */
export function computeTidComparison(input: MetricInput): TidComparisonSignal {
  return compareTid(computeSeilerTid(input), computeSeilerTid28d(input));
}

export interface PowerCurveAnchor {
  current_watts: number | null;
  previous_watts: number | null;
  pct_change: number | null;
}

export interface PowerCurveWindow {
  start: string;
  end: string;
}

export interface PowerCurveDelta {
  window_days: 28;
  current_window?: PowerCurveWindow;
  previous_window?: PowerCurveWindow;
  anchors: Record<string, PowerCurveAnchor> | null;
  rotation_index: number | null;
  note: string;
}

const POWER_CURVE_ANCHORS: Record<string, number> = {
  "5s": 5,
  "60s": 60,
  "300s": 300,
  "1200s": 1200,
  "3600s": 3600,
};

const POWER_CURVE_DELTA_NOTE =
  "Compares MMP at 5 anchor durations (5s neuromuscular, 60s anaerobic, " +
  "300s MAP, 1200s threshold, 3600s endurance) across two 28d windows. " +
  "rotation_index = mean(5s,60s pct_change) - mean(1200s,3600s pct_change). " +
  "Positive = sprint-biased gains, negative = endurance-biased. " +
  "300s excluded from rotation (transitional). " +
  "Null when either window has fewer than 3 valid anchor durations.";

/**
 * Power curve delta — the shift in mean-maximal power at anchor durations
 * across two adjacent 28-day windows, plus a `rotation_index` summarising
 * whether the gains are sprint- (positive) or endurance-biased (negative).
 *
 * The upstream derives `power_curve_dates` from the frozen clock ONLY when it
 * fetched power curves (the snapshot harness mirrors that gate), so
 * `powerCurveDates` here stays null whenever the fixture omits `power_curves`
 * — reproducing the dateless null block byte-for-byte. Curves are matched by
 * the `r.{start}.{end}` id string, never by list position; a missing id is a
 * silent null branch, not an error.
 *
 * Upstream source mirrored line-by-line: `sync.py:4297-4439`
 * (`_calculate_power_curve_delta`) with the window math wired by the harness
 * at `sync.py:2465-2469` (win1 = now-27..today, win2 = now-55..now-28).
 * See `NOTICE.md` for upstream attribution.
 *
 * @see Pinot, J., & Grappe, F. (2011). The record power profile to assess
 *      performance in elite cyclists. Int J Sports Med 32(11):839-844.
 */
export function computePowerCurveDelta(input: MetricInput): PowerCurveDelta {
  const powerCurveData = getPowerCurves(input);
  const powerCurveDates = powerCurveDatesFrom(input.frozenNow, powerCurveData);

  const nullBlock = (note = "Insufficient power data in one or both windows."): PowerCurveDelta => {
    const dates: Pick<PowerCurveDelta, "current_window" | "previous_window"> = {};
    if (powerCurveDates) {
      dates.current_window = { start: powerCurveDates[0], end: powerCurveDates[1] };
      dates.previous_window = { start: powerCurveDates[2], end: powerCurveDates[3] };
    }
    return {
      window_days: 28,
      ...dates,
      anchors: null,
      rotation_index: null,
      note,
    };
  };

  if (!powerCurveData || !powerCurveDates) {
    return nullBlock();
  }

  const curvesList = powerCurveData.list ?? [];
  if (curvesList.length === 0) {
    return nullBlock();
  }

  const [pcStart1, pcEnd1, pcStart2, pcEnd2] = powerCurveDates;
  const currentId = `r.${pcStart1}.${pcEnd1}`;
  const previousId = `r.${pcStart2}.${pcEnd2}`;

  const curvesById = new Map<string, PowerCurveData["list"][number]>();
  for (const c of curvesList) {
    if (!curvesById.has(c.id)) curvesById.set(c.id, c);
  }
  const currentCurve = curvesById.get(currentId);
  const previousCurve = curvesById.get(previousId);

  if (!currentCurve || !previousCurve) {
    const missing: string[] = [];
    if (!currentCurve) missing.push("current");
    if (!previousCurve) missing.push("previous");
    return nullBlock(`No power data in ${missing.join(" and ")} window(s).`);
  }

  const anchors: Record<string, PowerCurveAnchor> = {};
  for (const [label, durationSecs] of Object.entries(POWER_CURVE_ANCHORS)) {
    const curSecs = currentCurve.secs ?? [];
    const curWatts = currentCurve.watts ?? [];
    const prevSecs = previousCurve.secs ?? [];
    const prevWatts = previousCurve.watts ?? [];

    let curW: number | null = null;
    if (curSecs.includes(durationSecs)) {
      const idx = curSecs.indexOf(durationSecs);
      const val = idx < curWatts.length ? curWatts[idx] : null;
      if (val !== null && val !== undefined && val > 0) {
        curW = val;
      }
    }

    let prevW: number | null = null;
    if (prevSecs.includes(durationSecs)) {
      const idx = prevSecs.indexOf(durationSecs);
      const val = idx < prevWatts.length ? prevWatts[idx] : null;
      if (val !== null && val !== undefined && val > 0) {
        prevW = val;
      }
    }

    let pctChange: number | null = null;
    if (curW !== null && prevW !== null) {
      pctChange = roundHalfEven(((curW - prevW) / prevW) * 100, 1);
    }

    anchors[label] = {
      current_watts: curW,
      previous_watts: prevW,
      pct_change: pctChange,
    };
  }

  const currentValid = Object.values(anchors).filter((a) => a.current_watts !== null).length;
  const previousValid = Object.values(anchors).filter((a) => a.previous_watts !== null).length;

  if (currentValid < 3 || previousValid < 3) {
    return nullBlock(
      `Too few valid anchors (current: ${currentValid}, previous: ${previousValid}, need 3+).`,
    );
  }

  const shortChanges = [anchors["5s"].pct_change, anchors["60s"].pct_change];
  const longChanges = [anchors["1200s"].pct_change, anchors["3600s"].pct_change];

  let rotationIndex: number | null = null;
  if ([...shortChanges, ...longChanges].every((v) => v !== null)) {
    const shortMean = pythonSum(shortChanges as number[]) / shortChanges.length;
    const longMean = pythonSum(longChanges as number[]) / longChanges.length;
    rotationIndex = roundHalfEven(shortMean - longMean, 1);
  }

  return {
    window_days: 28,
    current_window: { start: pcStart1, end: pcEnd1 },
    previous_window: { start: pcStart2, end: pcEnd2 },
    anchors,
    rotation_index: rotationIndex,
    note: POWER_CURVE_DELTA_NOTE,
  };
}

// The four-date window tuple the harness passes as `power_curve_dates`,
// derived from the frozen clock — present only when the fixture carried
// `power_curves` (the upstream fetch gate, `sync.py:2465-2469`):
// current = [now-27, today], previous = [now-55, now-28].
function powerCurveDatesFrom(
  frozenNow: string,
  powerCurveData: PowerCurveData | null,
): [string, string, string, string] | null {
  if (!powerCurveData) return null;
  const today = frozenNow.slice(0, 10);
  return [
    isoDateDaysBefore(frozenNow, 27),
    today,
    isoDateDaysBefore(frozenNow, 55),
    isoDateDaysBefore(frozenNow, 28),
  ];
}

export interface HrCurveAnchor {
  current_bpm: number | null;
  previous_bpm: number | null;
  pct_change: number | null;
}

export interface HrCurveDelta {
  window_days: 28;
  current_window?: PowerCurveWindow;
  previous_window?: PowerCurveWindow;
  anchors: Record<string, HrCurveAnchor> | null;
  rotation_index: number | null;
  note: string;
}

// No 5s anchor — peak HR at 5s is just max HR, not an energy-system signal.
const HR_CURVE_ANCHORS: Record<string, number> = {
  "60s": 60,
  "300s": 300,
  "1200s": 1200,
  "3600s": 3600,
};

const HR_CURVE_DELTA_NOTE =
  "Compares max sustained HR at 4 anchor durations (60s anaerobic ceiling, " +
  "300s VO2max HR, 1200s threshold HR, 3600s endurance HR) across two 28d windows. " +
  "rotation_index = mean(60s,300s pct_change) - mean(1200s,3600s pct_change). " +
  "Positive = intensity-biased HR shift, negative = endurance-biased. " +
  "No sport filter — HR is cross-sport physiological (dominated by hardest efforts). " +
  "IMPORTANT: rising max sustained HR is ambiguous — may indicate improved cardiac " +
  "output (good) or accumulated fatigue/dehydration/heat (bad). Cross-reference with " +
  "resting HRV, resting HR, RPE, and environmental context before interpreting. " +
  "Null when either window has fewer than 3 valid anchor durations.";

/**
 * HR curve delta — the shift in max sustained heart rate at anchor durations
 * across two adjacent 28-day windows, plus a `rotation_index` summarising
 * whether the shift is intensity- (positive) or endurance-biased (negative).
 *
 * Unlike power, rising max sustained HR is ambiguous (improved cardiac output
 * vs accumulated fatigue/heat), so the signal is display-only context. There is
 * no 5s anchor and no sport filter — HR is cross-sport physiological. The
 * `values` key carries bpm where power curves carry `watts`.
 *
 * The delta REUSES `power_curve_dates` (the call site passes the power tuple),
 * so the window dates are gated on the harness having fetched `power_curves` —
 * HR curves without power dates reproduce the dateless null block byte-for-byte.
 *
 * Upstream source mirrored line-by-line: `sync.py:4441-4586`
 * (`_calculate_hr_curve_delta`) with the call site at `sync.py:3210` passing
 * `power_curve_dates`. See `NOTICE.md` for upstream attribution.
 */
export function computeHrCurveDelta(input: MetricInput): HrCurveDelta {
  const hrCurveData = getHrCurves(input);
  const curveDates = powerCurveDatesFrom(input.frozenNow, getPowerCurves(input));

  const nullBlock = (note = "Insufficient HR data in one or both windows."): HrCurveDelta => {
    const dates: Pick<HrCurveDelta, "current_window" | "previous_window"> = {};
    if (curveDates) {
      dates.current_window = { start: curveDates[0], end: curveDates[1] };
      dates.previous_window = { start: curveDates[2], end: curveDates[3] };
    }
    return {
      window_days: 28,
      ...dates,
      anchors: null,
      rotation_index: null,
      note,
    };
  };

  if (!hrCurveData || !curveDates) {
    return nullBlock();
  }

  const curvesList = hrCurveData.list ?? [];
  if (curvesList.length === 0) {
    return nullBlock();
  }

  const [pcStart1, pcEnd1, pcStart2, pcEnd2] = curveDates;
  const currentId = `r.${pcStart1}.${pcEnd1}`;
  const previousId = `r.${pcStart2}.${pcEnd2}`;

  const curvesById = new Map<string, HrCurveData["list"][number]>();
  for (const c of curvesList) {
    if (!curvesById.has(c.id)) curvesById.set(c.id, c);
  }
  const currentCurve = curvesById.get(currentId);
  const previousCurve = curvesById.get(previousId);

  if (!currentCurve || !previousCurve) {
    const missing: string[] = [];
    if (!currentCurve) missing.push("current");
    if (!previousCurve) missing.push("previous");
    return nullBlock(`No HR data in ${missing.join(" and ")} window(s).`);
  }

  const anchors: Record<string, HrCurveAnchor> = {};
  for (const [label, durationSecs] of Object.entries(HR_CURVE_ANCHORS)) {
    const curSecs = currentCurve.secs ?? [];
    const curValues = currentCurve.values ?? [];
    const prevSecs = previousCurve.secs ?? [];
    const prevValues = previousCurve.values ?? [];

    let curV: number | null = null;
    if (curSecs.includes(durationSecs)) {
      const idx = curSecs.indexOf(durationSecs);
      const val = idx < curValues.length ? curValues[idx] : null;
      if (val !== null && val !== undefined && val > 0) {
        curV = val;
      }
    }

    let prevV: number | null = null;
    if (prevSecs.includes(durationSecs)) {
      const idx = prevSecs.indexOf(durationSecs);
      const val = idx < prevValues.length ? prevValues[idx] : null;
      if (val !== null && val !== undefined && val > 0) {
        prevV = val;
      }
    }

    let pctChange: number | null = null;
    if (curV !== null && prevV !== null) {
      pctChange = roundHalfEven(((curV - prevV) / prevV) * 100, 1);
    }

    anchors[label] = {
      current_bpm: curV,
      previous_bpm: prevV,
      pct_change: pctChange,
    };
  }

  const currentValid = Object.values(anchors).filter((a) => a.current_bpm !== null).length;
  const previousValid = Object.values(anchors).filter((a) => a.previous_bpm !== null).length;

  if (currentValid < 3 || previousValid < 3) {
    return nullBlock(
      `Too few valid anchors (current: ${currentValid}, previous: ${previousValid}, need 3+).`,
    );
  }

  const shortChanges = [anchors["60s"].pct_change, anchors["300s"].pct_change];
  const longChanges = [anchors["1200s"].pct_change, anchors["3600s"].pct_change];

  let rotationIndex: number | null = null;
  if ([...shortChanges, ...longChanges].every((v) => v !== null)) {
    const shortMean = pythonSum(shortChanges as number[]) / shortChanges.length;
    const longMean = pythonSum(longChanges as number[]) / longChanges.length;
    rotationIndex = roundHalfEven(shortMean - longMean, 1);
  }

  return {
    window_days: 28,
    current_window: { start: pcStart1, end: pcEnd1 },
    previous_window: { start: pcStart2, end: pcEnd2 },
    anchors,
    rotation_index: rotationIndex,
    note: HR_CURVE_DELTA_NOTE,
  };
}
