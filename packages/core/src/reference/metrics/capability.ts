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

import { getActivitiesInWindow } from "./distribution.js";
import { getActivities, type MetricInput } from "./metric-input.js";
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
