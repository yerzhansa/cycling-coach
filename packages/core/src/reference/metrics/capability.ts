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
  getAthlete,
  getHrCurves,
  getPowerCurves,
  getStreams,
  getSustainabilityCurves,
  getWellness,
  type MetricInput,
} from "./metric-input.js";
import { computeSeilerTid, computeSeilerTid28d, type SeilerTid } from "./distribution.js";
import { resolvePowerModel } from "./power-model.js";
import { mean, pythonSum } from "./statistics.js";
import { roundHalfEven } from "./rounding.js";
import type {
  Activity,
  ActivityStreams,
  AthleteSettings,
  HrCurveData,
  PowerCurveData,
  SportSettingsRow,
  SustainabilityFamilyCurves,
  WellnessDay,
} from "../schemas/inputs.js";

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

const SUSTAINABILITY_WINDOW_DAYS = 42;

// Per-sport anchor durations (seconds). Mirrors SUSTAINABILITY_ANCHORS at
// sync.py:331-335 — only the families listed here get a block; everything else
// in the curve bundle is skipped.
const SUSTAINABILITY_ANCHORS: Record<string, Record<string, number>> = {
  cycling: {
    "300s": 300,
    "600s": 600,
    "1200s": 1200,
    "1800s": 1800,
    "3600s": 3600,
    "5400s": 5400,
    "7200s": 7200,
  },
  ski: { "60s": 60, "120s": 120, "300s": 300, "600s": 600, "1200s": 1200, "1800s": 1800 },
  rowing: { "60s": 60, "120s": 120, "300s": 300, "600s": 600, "1200s": 1200, "1800s": 1800 },
};

// Coggan duration factors — midpoints of published ranges, cycling only.
// Sustainable power as fraction of FTP by duration. Mirrors
// COGGAN_DURATION_FACTORS at sync.py:340-348.
const COGGAN_DURATION_FACTORS: Record<number, number> = {
  300: 1.06,
  600: 0.97,
  1200: 0.93,
  1800: 0.9,
  3600: 0.86,
  5400: 0.82,
  7200: 0.78,
};

// Maps an intervals.icu activity type to a sport family. Mirrors SPORT_FAMILIES
// at sync.py:290-305 (only the entries `_build_sport_thresholds` can fold into a
// sustainability family matter, but the full map is transliterated for fidelity).
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
};

// Indoor cycling activity types. Mirrors INDOOR_CYCLING_TYPES at sync.py:315.
const INDOOR_CYCLING_TYPES = new Set(["VirtualRide"]);

// `_is_indoor_cycling` (sync.py:317-320).
function isIndoorCycling(activityType: string): boolean {
  return INDOOR_CYCLING_TYPES.has(activityType);
}

// The per-family threshold entry `_build_sport_thresholds` folds each
// sportSettings row into. Only `ftp`/`ftp_indoor`/`lthr` feed the sustainability
// model; the other fields are transliterated so the populated-count tiebreak
// matches the upstream's.
interface SportThreshold {
  lthr: number | null;
  max_hr: number | null;
  threshold_pace: number | null;
  pace_units: string | null;
  ftp: number | null;
  ftp_indoor: number | null;
}

// `_build_sport_thresholds(athlete)` (sync.py:2756-2788). Folds the athlete's
// sportSettings array into a per-family threshold map. Each sport_type maps to a
// family via SPORT_FAMILIES; when multiple types collide on a family, the entry
// with more populated fields wins, ties broken by the lexicographically smaller
// sport_type. `ftp`/`ftp_indoor` carry Python's `x or None` truthiness (0 → null).
function buildSportThresholds(
  athlete: AthleteSettings | null,
): Record<string, SportThreshold> {
  const candidates = new Map<string, { entry: SportThreshold; populated: number; type: string }>();

  for (const sport of athlete?.sportSettings ?? []) {
    const row = sport as SportSettingsRow & {
      max_hr?: number | null;
      threshold_pace?: number | null;
      pace_units?: string | null;
    };
    for (const sportType of row.types ?? []) {
      const family = SPORT_FAMILIES[sportType];
      if (!family) continue;

      const rawPace = row.threshold_pace;
      const thresholdPace =
        rawPace !== null && rawPace !== undefined && rawPace !== 0 ? rawPace : null;
      const paceUnits = thresholdPace !== null ? row.pace_units ?? null : null;

      const entry: SportThreshold = {
        lthr: row.lthr ?? null,
        max_hr: row.max_hr ?? null,
        threshold_pace: thresholdPace,
        pace_units: paceUnits,
        ftp: row.ftp ? row.ftp : null,
        ftp_indoor: row.indoor_ftp ? row.indoor_ftp : null,
      };

      const populated = Object.values(entry).filter((v) => v !== null).length;
      const existing = candidates.get(family);
      if (
        !existing ||
        populated > existing.populated ||
        (populated === existing.populated && sportType < existing.type)
      ) {
        candidates.set(family, { entry, populated, type: sportType });
      }
    }
  }

  const out: Record<string, SportThreshold> = {};
  for (const [family, { entry }] of candidates) out[family] = entry;
  return out;
}

export interface SustainabilityAnchor {
  actual_watts: number | null;
  actual_wpkg: number | null;
  actual_hr: number | null;
  pct_lthr: number | null;
  source: string | null;
  coggan_watts?: number | null;
  coggan_wpkg?: number | null;
  cp_model_watts?: number | null;
  cp_model_wpkg?: number | null;
  model_divergence_pct?: number | null;
}

export interface SustainabilitySportBlock {
  anchors: Record<string, SustainabilityAnchor> | null;
  coverage_ratio: number;
  note?: string;
  ftp_used?: number | null;
  w_prime_used?: number | null;
  ftp_staleness_days?: number | null;
  model_trust_note?: string;
}

export interface SustainabilityWindow {
  days: number;
  start: string;
  end: string;
}

export interface SustainabilityProfile {
  note?: string;
  window?: SustainabilityWindow;
  weight_kg?: number | null;
  weight_source?: string | null;
  [sportFamily: string]: SustainabilitySportBlock | SustainabilityWindow | number | string | null | undefined;
}

const SUSTAINABILITY_MODEL_TRUST_NOTE =
  "CP/W' model (P=CP+W'/t) is primary for durations ≤20min where W' contribution " +
  "is meaningful. Coggan duration factors (Allen & Coggan, 3rd ed.) are the established " +
  "reference for ≥60min. 30min is the crossover zone where both apply. " +
  "model_divergence_pct = (actual - CP_model) / CP_model × 100. " +
  "Positive divergence at short durations may indicate strong anaerobic capacity " +
  "or stale W' value. Indoor MMP is typically 3-5% lower than outdoor (cooling, " +
  "motivation) — source flag indicates which environment produced each anchor.";

// Trailing wellness rows whose `id[:10]` falls in [frozenNow-(days-1), frozenNow],
// in fixture order. Mirrors the harness `_within(_wellness_all, "id", ...)` slices
// the upstream consumes as `wellness_7d` / `wellness_extended`.
function wellnessWindow(rows: WellnessDay[], days: number, frozenNow: string): WellnessDay[] {
  const oldest = isoDateDaysBefore(frozenNow, days - 1);
  const today = frozenNow.slice(0, 10);
  return rows.filter((r) => {
    if (typeof r.id !== "string") return false;
    const d = r.id.slice(0, 10);
    return oldest <= d && d <= today;
  });
}

// The harness's `icu_weight = _LATEST_WELLNESS.get("weight")`: the weight of the
// 28d-window row with the largest `id` (sorted descending). Null when no row
// qualifies or the latest row carries no weight.
function latestWindowWeight(rows28d: WellnessDay[]): number | null {
  if (rows28d.length === 0) return null;
  let latest = rows28d[0]!;
  for (const r of rows28d) {
    if ((r.id ?? "") > (latest.id ?? "")) latest = r;
  }
  return latest.weight ?? null;
}

/**
 * Sustainability profile — the per-sport race-estimation lookup table. For each
 * active sport family in `sustainability_curves`, extracts observed mean-maximal
 * power and max sustained HR at sport-specific anchor durations from a single
 * 42-day window, and (cycling only) layers two predicted-power models: Coggan
 * duration factors (FTP × factor) and the CP/W' model (P = CP + W'/t, CP
 * approximated by athlete-set FTP).
 *
 * The single 42d window is gated on the harness having fetched
 * `sustainability_curves`, so absent curves reproduce the bare null block (no
 * window key) byte-for-byte. `sport_settings` is rebuilt from `athlete` via the
 * upstream's own `_build_sport_thresholds`, `power_model.w_prime` from the live
 * power-model extraction (the same source the scalar passthroughs read), and the
 * weight fallback chain walks wellness_7d → wellness_extended → icu_weight.
 *
 * Upstream source mirrored line-by-line: `sync.py:4804-5092`
 * (`_calculate_sustainability_profile`) plus the `_build_sport_thresholds`
 * helper at `sync.py:2756-2788` and the `_is_indoor_cycling` classifier at
 * `sync.py:317-320`. The single 42d window and the cycling FTP/W' inputs are
 * wired by the harness per the live fetch path. `ftp_staleness_days` is null in
 * the gate context — the FTP-history file the upstream's `_load_ftp_history`
 * reads is not provided to this path, so its date set is always empty.
 * See `NOTICE.md` for upstream attribution.
 *
 * @see Allen, H., & Coggan, A. (2010). Training and Racing with a Power Meter
 *      (2nd ed.). VeloPress.
 * @see Skiba, P. F. et al. (2012). Modeling the expenditure and reconstitution
 *      of work capacity above critical power. Med Sci Sports Exerc 44(8):1526-1532.
 */
export function computeSustainabilityProfile(input: MetricInput): SustainabilityProfile {
  const sustainabilityCurves = getSustainabilityCurves(input);
  const sustainabilityWindow = sustainabilityWindowFrom(input.frozenNow, sustainabilityCurves);

  const nullProfile = (note = "No sustainability data available."): SustainabilityProfile => {
    const result: SustainabilityProfile = { note };
    if (sustainabilityWindow) {
      result.window = {
        days: SUSTAINABILITY_WINDOW_DAYS,
        start: sustainabilityWindow[0],
        end: sustainabilityWindow[1],
      };
    }
    return result;
  };

  if (Object.keys(sustainabilityCurves).length === 0 || !sustainabilityWindow) {
    return nullProfile();
  }

  const allWellness = getWellness(input);
  const wellness7d = wellnessWindow(allWellness, 7, input.frozenNow);
  const wellnessExtended = wellnessWindow(allWellness, 28, input.frozenNow);
  const icuWeight = latestWindowWeight(wellnessExtended);

  // --- Weight fallback chain ---
  let weightKg: number | null = null;
  let weightSource: string | null = null;

  for (let i = wellness7d.length - 1; i >= 0; i--) {
    const w = wellness7d[i]!.weight;
    if (w) {
      weightKg = roundHalfEven(w, 1);
      weightSource = "wellness_recent";
      break;
    }
  }
  if (weightKg === null) {
    for (let i = wellnessExtended.length - 1; i >= 0; i--) {
      const w = wellnessExtended[i]!.weight;
      if (w) {
        weightKg = roundHalfEven(w, 1);
        weightSource = "wellness_extended";
        break;
      }
    }
  }
  if (weightKg === null && icuWeight !== null && icuWeight !== undefined) {
    weightKg = roundHalfEven(icuWeight, 1);
    weightSource = "athlete_profile";
  }

  // --- FTP staleness (cycling only) — null in the gate context, see JSDoc. ---
  const ftpStalenessDays: number | null = null;

  // --- Cycling model inputs ---
  const sportSettings = buildSportThresholds(getAthlete(input));
  const cyclingSettings = sportSettings.cycling ?? null;
  // Use athlete-set FTP from sportSettings (not eFTP); fall back to indoor FTP.
  let cyclingFtp: number | null = cyclingSettings?.ftp ?? null;
  if (!cyclingFtp) {
    cyclingFtp = cyclingSettings?.ftp_indoor ?? null;
  }
  const cyclingWPrime = resolvePowerModel(input)?.w_prime ?? null;

  // --- Build per-sport blocks ---
  const profile: SustainabilityProfile = {
    window: {
      days: SUSTAINABILITY_WINDOW_DAYS,
      start: sustainabilityWindow[0],
      end: sustainabilityWindow[1],
    },
    weight_kg: weightKg,
    weight_source: weightSource,
  };

  const curveId = `r.${sustainabilityWindow[0]}.${sustainabilityWindow[1]}`;

  for (const [sportFamily, sportData] of Object.entries(sustainabilityCurves)) {
    const anchorsMap = SUSTAINABILITY_ANCHORS[sportFamily];
    if (!anchorsMap) continue;

    const sportLthr = sportSettings[sportFamily]?.lthr ?? null;
    const powerCurvesByType = sportData.power ?? {};
    const hrCurvesByType = sportData.hr ?? {};
    const isCycling = sportFamily === "cycling";

    const anchors: Record<string, SustainabilityAnchor> = {};

    for (const [label, durationSecs] of Object.entries(anchorsMap)) {
      let bestWatts: number | null = null;
      let bestSource: string | null = null;

      for (const [ptype, pdata] of Object.entries(powerCurvesByType)) {
        const curve = curveById(pdata, curveId);
        if (!curve) continue;
        const secs = curve.secs ?? [];
        const watts = curve.watts ?? [];
        if (secs.includes(durationSecs)) {
          const idx = secs.indexOf(durationSecs);
          const val = idx < watts.length ? watts[idx] : null;
          if (val !== null && val !== undefined && val > 0) {
            if (bestWatts === null || val > bestWatts) {
              bestWatts = val;
              if (isCycling) {
                bestSource = isIndoorCycling(ptype) ? "observed_indoor" : "observed_outdoor";
              } else {
                bestSource = "observed";
              }
            }
          }
        }
      }

      let bestHr: number | null = null;
      for (const [, hdata] of Object.entries(hrCurvesByType)) {
        const curve = hrCurveById(hdata, curveId);
        if (!curve) continue;
        const secs = curve.secs ?? [];
        const values = curve.values ?? [];
        if (secs.includes(durationSecs)) {
          const idx = secs.indexOf(durationSecs);
          const val = idx < values.length ? values[idx] : null;
          if (val !== null && val !== undefined && val > 0) {
            if (bestHr === null || val > bestHr) {
              bestHr = roundHalfEven(val, 0);
            }
          }
        }
      }

      let actualWpkg: number | null = null;
      if (bestWatts !== null && weightKg !== null && weightKg > 0) {
        actualWpkg = roundHalfEven(bestWatts / weightKg, 2);
      }

      let pctLthr: number | null = null;
      if (bestHr !== null && sportLthr !== null && sportLthr > 0) {
        pctLthr = roundHalfEven((bestHr / sportLthr) * 100, 1);
      }

      let cogganWatts: number | null = null;
      let cogganWpkg: number | null = null;
      if (isCycling && cyclingFtp && durationSecs in COGGAN_DURATION_FACTORS) {
        cogganWatts = roundHalfEven(cyclingFtp * COGGAN_DURATION_FACTORS[durationSecs]!, 0);
        if (weightKg && weightKg > 0) {
          cogganWpkg = roundHalfEven(cogganWatts / weightKg, 2);
        }
      }

      let cpModelWatts: number | null = null;
      let cpModelWpkg: number | null = null;
      if (isCycling && cyclingFtp && cyclingWPrime && durationSecs > 0) {
        cpModelWatts = roundHalfEven(cyclingFtp + cyclingWPrime / durationSecs, 0);
        if (weightKg && weightKg > 0) {
          cpModelWpkg = roundHalfEven(cpModelWatts / weightKg, 2);
        }
      }

      let modelDivergencePct: number | null = null;
      if (bestWatts !== null && cpModelWatts !== null && cpModelWatts > 0) {
        modelDivergencePct = roundHalfEven(((bestWatts - cpModelWatts) / cpModelWatts) * 100, 1);
      }

      const anchorData: SustainabilityAnchor = {
        actual_watts: bestWatts,
        actual_wpkg: actualWpkg,
        actual_hr: bestHr,
        pct_lthr: pctLthr,
        source: bestSource,
      };

      if (isCycling) {
        anchorData.coggan_watts = cogganWatts;
        anchorData.coggan_wpkg = cogganWpkg;
        anchorData.cp_model_watts = cpModelWatts;
        anchorData.cp_model_wpkg = cpModelWpkg;
        anchorData.model_divergence_pct = modelDivergencePct;
      }

      anchors[label] = anchorData;
    }

    const totalAnchors = Object.keys(anchors).length;
    const observedAnchors = Object.values(anchors).filter(
      (a) => a.actual_watts !== null,
    ).length;
    const coverageRatio =
      totalAnchors > 0 ? roundHalfEven(observedAnchors / totalAnchors, 2) : 0;

    if (observedAnchors < 2) {
      profile[sportFamily] = {
        anchors: null,
        coverage_ratio: coverageRatio,
        note: `Too few observed anchors (${observedAnchors}, need 2+).`,
      };
      continue;
    }

    const sportBlock: SustainabilitySportBlock = {
      anchors,
      coverage_ratio: coverageRatio,
    };

    if (isCycling) {
      sportBlock.ftp_used = cyclingFtp;
      sportBlock.w_prime_used = cyclingWPrime;
      sportBlock.ftp_staleness_days = ftpStalenessDays;
      sportBlock.model_trust_note = SUSTAINABILITY_MODEL_TRUST_NOTE;
    }

    profile[sportFamily] = sportBlock;
  }

  const hasSportData = Object.keys(profile).some(
    (k) => k !== "window" && k !== "weight_kg" && k !== "weight_source" && k !== "note",
  );
  if (!hasSportData) {
    return nullProfile("No sport families produced valid sustainability data.");
  }

  return profile;
}

// The single 42d window the harness passes as `sustainability_window`, derived
// from the frozen clock — present only when the fixture carried
// `sustainability_curves` (the upstream fetch gate, sync.py:2493-2494):
// [now-41, today].
function sustainabilityWindowFrom(
  frozenNow: string,
  curves: Record<string, SustainabilityFamilyCurves>,
): [string, string] | null {
  if (Object.keys(curves).length === 0) return null;
  return [isoDateDaysBefore(frozenNow, SUSTAINABILITY_WINDOW_DAYS - 1), frozenNow.slice(0, 10)];
}

// `curves_by_id.get(curve_id)` for a power `{list}` envelope, mirroring the
// upstream's `{c["id"]: c for c in list}` dict comprehension — last occurrence
// wins on duplicate ids.
function curveById(
  pdata: PowerCurveData,
  curveId: string,
): PowerCurveData["list"][number] | null {
  const list = pdata?.list ?? [];
  let match: PowerCurveData["list"][number] | null = null;
  for (const c of list) {
    if (c.id === curveId) match = c;
  }
  return match;
}

function hrCurveById(
  hdata: HrCurveData,
  curveId: string,
): HrCurveData["list"][number] | null {
  const list = hdata?.list ?? [];
  let match: HrCurveData["list"][number] | null = null;
  for (const c of list) {
    if (c.id === curveId) match = c;
  }
  return match;
}

// ─── DFA a1 profile ────────────────────────────────────────────────────────

// Per-session DFA a1 interpretation thresholds (sync.py:273-284). The 1.0/0.5
// mapping is cycling-validated; other sports get rollups but validated=false.
const DFA_LT1 = 1.0;
const DFA_LT2 = 0.5;
const DFA_LT1_BAND = 0.05;
const DFA_LT2_BAND = 0.05;
const DFA_MIN_CROSSING_DWELL_SECS = 60;
const DFA_ARTIFACT_MAX_PCT = 5.0;
const DFA_MIN_VALID_VALUE = 0.01;
const DFA_MIN_DURATION_SECS = 1200;
const DFA_SUFFICIENT_MIN_VALID_PCT = 70.0;
const DFA_DRIFT_INTERPRETABLE_MAX_LT2_PCT = 15.0;
const DFA_TRAILING_WINDOW_N = 7;
const DFA_VALIDATED_SPORTS = new Set(["cycling"]);

interface DfaBandStats {
  secs: number;
  pct: number;
  avg_hr: number | null;
  avg_watts: number | null;
}

interface DfaDrift {
  first_third_avg: number;
  last_third_avg: number;
  delta: number;
  interpretable: boolean;
}

interface DfaCrossing {
  secs_in_band: number;
  avg_hr: number | null;
  avg_watts: number | null;
}

interface DfaQuality {
  valid_secs: number;
  total_secs: number;
  valid_pct: number;
  artifact_rate_avg: number | null;
  sufficient: boolean;
}

interface DfaBlock {
  avg: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  tiz_below_lt1: DfaBandStats | null;
  tiz_lt1_transition: DfaBandStats | null;
  tiz_transition_lt2: DfaBandStats | null;
  tiz_above_lt2: DfaBandStats | null;
  drift: DfaDrift | null;
  lt1_crossing: DfaCrossing | null;
  lt2_crossing: DfaCrossing | null;
  quality: DfaQuality;
}

// Per-interval DFA activity entry, the shape the snapshot harness assembles
// into the upstream's `_intervals_data['activities']` before
// `_calculate_dfa_a1_profile` reads it. `dfa` is the block from
// `_compute_dfa_block`.
interface DfaActivity {
  activity_id: number | string | null;
  date: string;
  type: string;
  name: string;
  dfa: DfaBlock;
}

// Indoor cycling activity types (sync.py:315) and the resolver (sync.py:317-320).
// A second copy of the sustainability-profile constant lives above; kept local
// to each metric to mirror the single upstream class method without coupling the
// two ports.
const DFA_INDOOR_CYCLING_TYPES = new Set(["VirtualRide"]);
function dfaIsIndoorCycling(activityType: string): boolean {
  return DFA_INDOOR_CYCLING_TYPES.has(activityType);
}

/**
 * Per-session DFA a1 rollup from raw streams. Mirrors `_compute_dfa_block`
 * (sync.py:944-1124) line-by-line.
 *
 * Returns null when the `dfa_a1` channel is absent entirely (AlphaHRV did not
 * record). When present but insufficient (too short, too noisy) returns a block
 * with `quality.sufficient=false` and all-null rollups so the caller can tell
 * "no AlphaHRV" (null) from "ran but unusable" (block, sufficient=false).
 *
 * Filtering (in order): drop seconds where dfa_a1 < 0.01 (AlphaHRV sentinel
 * zeros), then drop seconds where artifacts % > 5 (Altini convention). Both
 * filters apply jointly to dfa_a1/hr/watts so they stay index-aligned.
 *
 * Numerically sensitive: every `round()` site mirrors Python banker's rounding
 * via `roundHalfEven`; `sum()` over the float dfa values uses the compensated
 * `pythonSum` to match CPython 3.12+. See `NOTICE.md` for upstream attribution.
 */
export function buildDfaBlock(streams: ActivityStreams): DfaBlock | null {
  const dfaStream = streams.dfa_a1;
  if (!dfaStream || dfaStream.length === 0) {
    return null; // no AlphaHRV recording on this activity
  }

  const n = dfaStream.length;
  const filled = <T>(value: T): T[] => Array.from({ length: n }, () => value);
  let artifactsStream: (number | null)[] = streams.artifacts ?? filled<number | null>(0.0);
  let hrStream: (number | null)[] = streams.heartrate ?? filled<number | null>(null);
  let wattsStream: (number | null)[] = streams.watts ?? filled<number | null>(null);

  // Align all streams to dfa_a1 length (defensive — should already match).
  if (artifactsStream.length !== n) {
    artifactsStream = artifactsStream.concat(filled<number | null>(0.0)).slice(0, n);
  }
  if (hrStream.length !== n) {
    hrStream = hrStream.concat(filled<number | null>(null)).slice(0, n);
  }
  if (wattsStream.length !== n) {
    wattsStream = wattsStream.concat(filled<number | null>(null)).slice(0, n);
  }

  const validDfa: number[] = [];
  const validHr: (number | null)[] = [];
  const validWatts: (number | null)[] = [];
  let artifactSum = 0.0;
  let artifactCount = 0;
  for (let i = 0; i < n; i++) {
    const d = dfaStream[i]!;
    const a = artifactsStream[i]!;
    if (a !== null) {
      artifactSum += a;
      artifactCount += 1;
    }
    if (d === null || d < DFA_MIN_VALID_VALUE) continue;
    if (a !== null && a > DFA_ARTIFACT_MAX_PCT) continue;
    validDfa.push(d);
    validHr.push(hrStream[i]!);
    validWatts.push(wattsStream[i]!);
  }

  const validSecs = validDfa.length;
  const totalSecs = n;
  const validPct = totalSecs ? roundHalfEven((100.0 * validSecs) / totalSecs, 1) : 0.0;
  const artifactRateAvg = artifactCount
    ? roundHalfEven(artifactSum / artifactCount, 2)
    : null;
  const sufficient =
    validSecs >= DFA_MIN_DURATION_SECS && validPct >= DFA_SUFFICIENT_MIN_VALID_PCT;

  const quality: DfaQuality = {
    valid_secs: validSecs,
    total_secs: totalSecs,
    valid_pct: validPct,
    artifact_rate_avg: artifactRateAvg,
    sufficient,
  };

  if (!sufficient) {
    return {
      avg: null,
      p25: null,
      p50: null,
      p75: null,
      tiz_below_lt1: null,
      tiz_lt1_transition: null,
      tiz_transition_lt2: null,
      tiz_above_lt2: null,
      drift: null,
      lt1_crossing: null,
      lt2_crossing: null,
      quality,
    };
  }

  const sortedDfa = [...validDfa].sort((x, y) => x - y);
  const avg = roundHalfEven(pythonSum(validDfa) / validSecs, 3);
  const p25 = roundHalfEven(sortedDfa[Math.floor(validSecs / 4)]!, 3);
  const p50 = roundHalfEven(sortedDfa[Math.floor(validSecs / 2)]!, 3);
  const p75 = roundHalfEven(sortedDfa[Math.floor((validSecs * 3) / 4)]!, 3);

  const bandStats = (predicate: (d: number) => boolean): DfaBandStats | null => {
    let secs = 0;
    let hrSum = 0;
    let hrN = 0;
    let wSum = 0;
    let wN = 0;
    for (let i = 0; i < validSecs; i++) {
      if (predicate(validDfa[i]!)) {
        secs += 1;
        if (validHr[i] !== null) {
          hrSum += validHr[i]!;
          hrN += 1;
        }
        if (validWatts[i] !== null) {
          wSum += validWatts[i]!;
          wN += 1;
        }
      }
    }
    if (secs === 0) return null;
    return {
      secs,
      pct: roundHalfEven((100.0 * secs) / validSecs, 1),
      avg_hr: hrN ? roundHalfEven(hrSum / hrN, 0) : null,
      avg_watts: wN ? roundHalfEven(wSum / wN, 0) : null,
    };
  };

  const tizBelowLt1 = bandStats((d) => d > DFA_LT1);
  const tizLt1Transition = bandStats((d) => 0.75 <= d && d <= DFA_LT1);
  const tizTransitionLt2 = bandStats((d) => DFA_LT2 <= d && d < 0.75);
  const tizAboveLt2 = bandStats((d) => d < DFA_LT2);

  // Drift: first-third vs last-third of valid data.
  const third = Math.floor(validSecs / 3);
  let drift: DfaDrift | null;
  if (third >= 60) {
    const firstThird = validDfa.slice(0, third);
    const lastThird = validDfa.slice(validSecs - third);
    const firstAvg = roundHalfEven(pythonSum(firstThird) / firstThird.length, 3);
    const lastAvg = roundHalfEven(pythonSum(lastThird) / lastThird.length, 3);
    const driftDelta = roundHalfEven(lastAvg - firstAvg, 3);
    const aboveLt2Pct = tizAboveLt2 ? tizAboveLt2.pct : 0.0;
    const interpretable = aboveLt2Pct <= DFA_DRIFT_INTERPRETABLE_MAX_LT2_PCT;
    drift = {
      first_third_avg: firstAvg,
      last_third_avg: lastAvg,
      delta: driftDelta,
      interpretable,
    };
  } else {
    drift = null;
  }

  // LT1 / LT2 crossing-band estimates.
  const crossingStats = (center: number, band: number): DfaCrossing => {
    const lo = center - band;
    const hi = center + band;
    let secs = 0;
    let hrSum = 0;
    let hrN = 0;
    let wSum = 0;
    let wN = 0;
    for (let i = 0; i < validSecs; i++) {
      if (lo <= validDfa[i]! && validDfa[i]! <= hi) {
        secs += 1;
        if (validHr[i] !== null) {
          hrSum += validHr[i]!;
          hrN += 1;
        }
        if (validWatts[i] !== null) {
          wSum += validWatts[i]!;
          wN += 1;
        }
      }
    }
    if (secs < DFA_MIN_CROSSING_DWELL_SECS) {
      return { secs_in_band: secs, avg_hr: null, avg_watts: null };
    }
    return {
      secs_in_band: secs,
      avg_hr: hrN ? roundHalfEven(hrSum / hrN, 0) : null,
      avg_watts: wN ? roundHalfEven(wSum / wN, 0) : null,
    };
  };

  const lt1Crossing = crossingStats(DFA_LT1, DFA_LT1_BAND);
  const lt2Crossing = crossingStats(DFA_LT2, DFA_LT2_BAND);

  return {
    avg,
    p25,
    p50,
    p75,
    tiz_below_lt1: tizBelowLt1,
    tiz_lt1_transition: tizLt1Transition,
    tiz_transition_lt2: tizTransitionLt2,
    tiz_above_lt2: tizAboveLt2,
    drift,
    lt1_crossing: lt1Crossing,
    lt2_crossing: lt2Crossing,
    quality,
  };
}

// Streams-assembly path the snapshot harness runs before
// `_calculate_dfa_a1_profile`: join each activity to its stream record by
// `String(id)`, keep records that carry a `dfa_a1` channel, run each through
// `buildDfaBlock`, and collect the per-interval activity entries the profile
// reads. The upstream stores these on `_intervals_data`; here they are passed
// directly. Absent streams (or no qualifying record) yield an empty list, which
// the profile maps to null.
function assembleDfaActivities(input: MetricInput): DfaActivity[] {
  const streams = getStreams(input);
  if (Object.keys(streams).length === 0) return [];

  const out: DfaActivity[] = [];
  for (const act of getActivities(input)) {
    const rec = streams[String(act.id)];
    if (!rec || !rec.dfa_a1 || rec.dfa_a1.length === 0) continue;
    const block = buildDfaBlock(rec);
    if (block === null) continue;
    // `name` is a loose ride-through field (not in ActivitySchema's typed
    // surface). Mirror the harness's `_sact.get("name", "")` default.
    const name = (act as { name?: string }).name ?? "";
    out.push({
      activity_id: act.id,
      date: act.start_date_local.slice(0, 10),
      type: act.type,
      name,
      dfa: block,
    });
  }
  return out;
}

interface DfaLatestSession {
  activity_id: number | string | null;
  date: string;
  name: string;
  sport: string;
  validated: boolean;
  avg: number | null;
  tiz_split_pct: Record<string, number> | null;
  drift_delta: number | null;
  drift_interpretable: boolean | null;
  quality_pct: number | null;
  sufficient: boolean;
}

interface DfaThresholdEstimateCycling {
  hr: number | null;
  watts_outdoor: number | null;
  watts_indoor: number | null;
  n_sessions: number;
  n_sessions_outdoor: number;
  n_sessions_indoor: number;
}

interface DfaThresholdEstimatePooled {
  hr: number | null;
  watts: number | null;
  n_sessions: number;
}

interface DfaSportBlock {
  n_sessions: number;
  date_range: [string | null, string | null];
  avg_dfa_a1: number | null;
  drift_delta_mean: number | null;
  lt1_crossing_sessions: number;
  lt2_crossing_sessions: number;
  lt1_estimate: DfaThresholdEstimateCycling | DfaThresholdEstimatePooled | null;
  lt2_estimate: DfaThresholdEstimateCycling | DfaThresholdEstimatePooled | null;
  quality_avg_pct: number;
  validated: boolean;
  confidence: "high" | "moderate" | "low" | null;
  note?: string;
}

export interface DfaA1Profile {
  latest_session: DfaLatestSession;
  trailing_by_sport: Record<string, DfaSportBlock>;
}

/**
 * DFA a1 profile for the capability block. Mirrors `_calculate_dfa_a1_profile`
 * (sync.py:4588-4802) line-by-line, fed by the streams-assembly path the harness
 * runs before the call (`assembleDfaActivities`).
 *
 * Returns:
 *   - latest_session: most recent activity with a sufficient dfa block (any
 *     sport); falls back to the most recent insufficient one so the caller sees
 *     "AlphaHRV ran but unusable" instead of "no data".
 *   - trailing_by_sport: per sport family, aggregated rollups across the latest
 *     DFA_TRAILING_WINDOW_N sufficient sessions, with confidence + validated
 *     flags and crossing-band LT1/LT2 estimates (cycling splits watts by
 *     indoor/outdoor environment; other sports keep pooled watts).
 *
 * Returns null when no stream record carries a dfa_a1 channel — mirroring the
 * upstream's "no intervals data / no DFA-equipped sessions" null return.
 *
 * Numerically sensitive: every `round()` mirrors Python banker's rounding via
 * `roundHalfEven` (including the no-arg `round(x)` int form ported as
 * `roundHalfEven(x, 0)`); float `sum()` over avg/drift values uses the
 * compensated `pythonSum`. Integer floor division `//` is `Math.floor` (all
 * operands non-negative). See `NOTICE.md` for upstream attribution.
 *
 * @see Rowlands, D. S. et al. (2017); Gronwald, T. & Hoos, O. (2020);
 *      Mateo-March, M. et al. (2023) — cycling DFA a1 threshold validation.
 */
export function computeDfaA1Profile(input: MetricInput): DfaA1Profile | null {
  const activities = assembleDfaActivities(input);
  // Keep only activities with a dfa block, most recent first.
  const dfaActivities = activities.filter((a) => a.dfa !== null);
  if (dfaActivities.length === 0) return null;
  // Stable descending sort by date, mirroring Python's stable list.sort.
  const ordered = [...dfaActivities]
    .map((a, i) => ({ a, i }))
    .sort((x, y) => {
      const dx = x.a.date ?? "";
      const dy = y.a.date ?? "";
      if (dx < dy) return 1;
      if (dx > dy) return -1;
      return x.i - y.i;
    })
    .map((e) => e.a);

  // --- latest_session: most recent SUFFICIENT session ---
  let latestSession: DfaLatestSession | null = null;
  for (const a of ordered) {
    const block = a.dfa;
    const quality = block.quality;
    if (quality.sufficient) {
      const tizSplit: Record<string, number> = {};
      const tizPairs: [keyof DfaBlock, string][] = [
        ["tiz_below_lt1", "below_lt1"],
        ["tiz_lt1_transition", "lt1_transition"],
        ["tiz_transition_lt2", "transition_lt2"],
        ["tiz_above_lt2", "above_lt2"],
      ];
      for (const [key, label] of tizPairs) {
        const band = block[key] as DfaBandStats | null;
        tizSplit[label] = band ? band.pct : 0.0;
      }
      const drift = block.drift ?? null;
      latestSession = {
        activity_id: a.activity_id,
        date: a.date,
        name: a.name,
        sport: a.type,
        validated: DFA_VALIDATED_SPORTS.has(SPORT_FAMILIES[a.type] ?? ""),
        avg: block.avg,
        tiz_split_pct: tizSplit,
        drift_delta: drift ? drift.delta : null,
        drift_interpretable: drift ? drift.interpretable : null,
        quality_pct: quality.valid_pct,
        sufficient: true,
      };
      break;
    }
  }

  if (latestSession === null) {
    const a = ordered[0]!;
    latestSession = {
      activity_id: a.activity_id,
      date: a.date,
      name: a.name,
      sport: a.type,
      validated: DFA_VALIDATED_SPORTS.has(SPORT_FAMILIES[a.type] ?? ""),
      avg: null,
      tiz_split_pct: null,
      drift_delta: null,
      drift_interpretable: null,
      quality_pct: a.dfa.quality.valid_pct,
      sufficient: false,
    };
  }

  // --- trailing_by_sport: per-sport aggregation across last N sufficient sessions ---
  const trailingBySport: Record<string, DfaSportBlock> = {};
  const byFamily = new Map<string, DfaActivity[]>();
  for (const a of ordered) {
    if (!a.dfa.quality.sufficient) continue;
    const family = SPORT_FAMILIES[a.type] ?? "other";
    if (!byFamily.has(family)) byFamily.set(family, []);
    byFamily.get(family)!.push(a);
  }

  for (const [family, acts] of byFamily) {
    const window = acts.slice(0, DFA_TRAILING_WINDOW_N);
    const n = window.length;
    if (n === 0) continue;

    const avgDfaValues = window
      .map((a) => a.dfa.avg)
      .filter((v): v is number => v !== null && v !== undefined);
    const avgDfa = avgDfaValues.length
      ? roundHalfEven(pythonSum(avgDfaValues) / avgDfaValues.length, 3)
      : null;
    const driftValues = window
      .filter(
        (a) =>
          a.dfa.drift &&
          a.dfa.drift.interpretable &&
          a.dfa.drift.delta !== null &&
          a.dfa.drift.delta !== undefined,
      )
      .map((a) => a.dfa.drift!.delta);
    const driftMean = driftValues.length
      ? roundHalfEven(pythonSum(driftValues) / driftValues.length, 3)
      : null;

    // Threshold estimates from crossing bands — only sessions with sufficient dwell.
    const avgCrossing = (
      key: "lt1_crossing" | "lt2_crossing",
      field: "avg_hr" | "avg_watts",
      subset?: DfaActivity[],
    ): [number | null, number] => {
      const source = subset ?? window;
      const vals: number[] = [];
      for (const a of source) {
        const cb = a.dfa[key];
        if (cb && cb.secs_in_band >= DFA_MIN_CROSSING_DWELL_SECS) {
          const v = cb[field];
          if (v !== null && v !== undefined) vals.push(v);
        }
      }
      if (vals.length === 0) return [null, 0];
      return [roundHalfEven(pythonSum(vals) / vals.length, 0), vals.length];
    };

    // HR estimates — pooled across all sessions.
    const [lt1Hr, lt1NHr] = avgCrossing("lt1_crossing", "avg_hr");
    const [lt2Hr, lt2NHr] = avgCrossing("lt2_crossing", "avg_hr");

    const isCycling = family === "cycling";
    let lt1Watts: number | null = null;
    let lt2Watts: number | null = null;
    let lt1NW = 0;
    let lt2NW = 0;
    let lt1WattsOut: number | null = null;
    let lt1WattsIn: number | null = null;
    let lt2WattsOut: number | null = null;
    let lt2WattsIn: number | null = null;
    let lt1NWOut = 0;
    let lt1NWIn = 0;
    let lt2NWOut = 0;
    let lt2NWIn = 0;
    if (isCycling) {
      const indoor = window.filter((a) => dfaIsIndoorCycling(a.type));
      const outdoor = window.filter((a) => !dfaIsIndoorCycling(a.type));
      [lt1WattsOut, lt1NWOut] = avgCrossing("lt1_crossing", "avg_watts", outdoor);
      [lt1WattsIn, lt1NWIn] = avgCrossing("lt1_crossing", "avg_watts", indoor);
      [lt2WattsOut, lt2NWOut] = avgCrossing("lt2_crossing", "avg_watts", outdoor);
      [lt2WattsIn, lt2NWIn] = avgCrossing("lt2_crossing", "avg_watts", indoor);
      lt1NW = lt1NWOut + lt1NWIn;
      lt2NW = lt2NWOut + lt2NWIn;
    } else {
      [lt1Watts, lt1NW] = avgCrossing("lt1_crossing", "avg_watts");
      [lt2Watts, lt2NW] = avgCrossing("lt2_crossing", "avg_watts");
    }

    const lt1CrossingSessions = window.filter(
      (a) => (a.dfa.lt1_crossing?.secs_in_band ?? 0) >= DFA_MIN_CROSSING_DWELL_SECS,
    ).length;
    const lt2CrossingSessions = window.filter(
      (a) => (a.dfa.lt2_crossing?.secs_in_band ?? 0) >= DFA_MIN_CROSSING_DWELL_SECS,
    ).length;

    const crossingN = Math.max(lt1NHr, lt1NW, lt2NHr, lt2NW);
    let confidence: "high" | "moderate" | "low" | null;
    if (crossingN >= 6) confidence = "high";
    else if (crossingN >= 4) confidence = "moderate";
    else if (crossingN >= 3) confidence = "low";
    else confidence = null;

    const qualityAvg = roundHalfEven(
      pythonSum(window.map((a) => a.dfa.quality.valid_pct)) / n,
      1,
    );

    const validated = DFA_VALIDATED_SPORTS.has(family);

    let lt1Est: DfaThresholdEstimateCycling | DfaThresholdEstimatePooled | null;
    let lt2Est: DfaThresholdEstimateCycling | DfaThresholdEstimatePooled | null;
    if (isCycling) {
      lt1Est = confidence
        ? {
            hr: lt1Hr,
            watts_outdoor: lt1WattsOut,
            watts_indoor: lt1WattsIn,
            n_sessions: Math.max(lt1NHr, lt1NW),
            n_sessions_outdoor: lt1NWOut,
            n_sessions_indoor: lt1NWIn,
          }
        : null;
      lt2Est = confidence
        ? {
            hr: lt2Hr,
            watts_outdoor: lt2WattsOut,
            watts_indoor: lt2WattsIn,
            n_sessions: Math.max(lt2NHr, lt2NW),
            n_sessions_outdoor: lt2NWOut,
            n_sessions_indoor: lt2NWIn,
          }
        : null;
    } else {
      lt1Est = confidence
        ? {
            hr: lt1Hr,
            watts: lt1Watts,
            n_sessions: Math.max(lt1NHr, lt1NW),
          }
        : null;
      lt2Est = confidence
        ? {
            hr: lt2Hr,
            watts: lt2Watts,
            n_sessions: Math.max(lt2NHr, lt2NW),
          }
        : null;
    }

    const sportBlock: DfaSportBlock = {
      n_sessions: n,
      date_range: [window[n - 1]!.date ?? null, window[0]!.date ?? null],
      avg_dfa_a1: avgDfa,
      drift_delta_mean: driftMean,
      lt1_crossing_sessions: lt1CrossingSessions,
      lt2_crossing_sessions: lt2CrossingSessions,
      lt1_estimate: lt1Est,
      lt2_estimate: lt2Est,
      quality_avg_pct: qualityAvg,
      validated,
      confidence,
    };
    if (!validated) {
      sportBlock.note =
        `DFA a1 threshold mapping (1.0/0.5) is cycling-validated. ` +
        `${family} thresholds may differ — treat estimates as informational only.`;
    }
    trailingBySport[family] = sportBlock;
  }

  return {
    latest_session: latestSession,
    trailing_by_sport: trailingBySport,
  };
}
