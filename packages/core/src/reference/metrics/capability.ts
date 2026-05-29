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

import { getActivities, getActivitiesInWindow, type MetricInput } from "./metric-input.js";
import { computeSeilerTid, computeSeilerTid28d, type SeilerTid } from "./distribution.js";
import { mean } from "./statistics.js";
import { roundHalfEven } from "./rounding.js";
import type { Activity } from "../schemas/inputs.js";

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
