/**
 * Reference layer — training-zone distribution metrics.
 *
 * This module lands the zone substrate the distribution tier builds on:
 * per-activity zone-time extraction (power-preferred, HR fallback) and
 * the trailing-window aggregation into Z1/Z2/Z3/Z4+ totals. The metric
 * math is ported from the Reference layer's upstream protocol. See
 * `NOTICE.md` for license attribution.
 */

import type { Activity } from "../schemas/inputs.js";

import { isoDateDaysBefore } from "./date-helpers.js";
import { getActivities, type MetricInput } from "./metric-input.js";
import { roundHalfEven } from "./rounding.js";
import { SPORT_FAMILIES } from "./sport-families.js";
import { pythonSum } from "./statistics.js";

/**
 * 7-day zone-hours distribution.
 *
 * Each zone's accumulated seconds over the trailing 7-day window, divided
 * by 3600 and rounded half-to-even to 2 dp. `z4_plus_hours` folds the four
 * hard zones (z4..z7) into one bucket per the Seiler polarized framing
 * (Z1–Z2 easy, Z3 grey/tempo, Z4+ hard). `zone_basis` reports whether the
 * underlying times came from power zones, HR zones, both (`"mixed"`), or
 * no zone data at all (`null`).
 *
 * Upstream source mirrored line-by-line: `sync.py:3376-3382` (emit) over
 * the totals from `_aggregate_zones` (`sync.py:3814`), which in turn calls
 * the per-activity `_get_activity_zones` (`sync.py:3683`). See `NOTICE.md`
 * for upstream attribution.
 *
 * Return shape is the raw upstream output, not a discriminated-union
 * envelope. Raw compute functions feed the parity gate; a sibling envelope
 * wrapper will feed the curator when the curator integration lands.
 */
export interface ZoneDistribution7d {
  total_hours: number;
  z1_hours: number;
  z2_hours: number;
  z3_hours: number;
  z4_plus_hours: number;
  zone_basis: "power" | "hr" | "mixed" | null;
}

export function computeZoneDistribution7d(input: MetricInput): ZoneDistribution7d {
  const activities7d = getActivitiesInWindow(getActivities(input), 7, input.frozenNow);
  const totals = aggregateZones(activities7d, DEFAULT_ZONE_PREFERENCE);

  return {
    z1_hours: roundHalfEven(totals.z1Time / 3600, 2),
    z2_hours: roundHalfEven(totals.z2Time / 3600, 2),
    z3_hours: roundHalfEven(totals.z3Time / 3600, 2),
    z4_plus_hours: roundHalfEven(totals.z4PlusTime / 3600, 2),
    total_hours: roundHalfEven(totals.totalTime / 3600, 2),
    zone_basis: totals.zoneBasis,
  };
}

/**
 * Grey-zone percentage — the share of trailing-7-day zone time spent in
 * Z3 (tempo). Per Seiler's polarized model this is the band to minimize
 * ("too much pain for too little gain"). Returns `null` when no zone time
 * was accumulated. There is no low/ok/high band classification — the
 * upstream emits the bare percentage.
 *
 * Mirrors `sync.py:3149` line-by-line:
 *   round((z3_time / total_zone_time) * 100, 1) if total_zone_time > 0 else None
 */
export function computeGreyZonePercentage(input: MetricInput): number | null {
  const activities7d = getActivitiesInWindow(getActivities(input), 7, input.frozenNow);
  const totals = aggregateZones(activities7d, DEFAULT_ZONE_PREFERENCE);

  if (totals.totalTime > 0) {
    return roundHalfEven((totals.z3Time / totals.totalTime) * 100, 1);
  }
  return null;
}

/**
 * Static companion note the upstream emits alongside the grey-zone
 * percentage. A constant string — mirrors `sync.py:3385` exactly.
 */
const GREY_ZONE_NOTE = "Gray Zone % (Z3/tempo) - minimize in polarized training";

export function computeGreyZoneNote(): string {
  return GREY_ZONE_NOTE;
}

/**
 * Quality-intensity percentage — the share of trailing-7-day zone time
 * spent in Z4+ (above LT2, the "hard" work). Per Seiler's polarized model
 * this is the band to target at ~20%. Returns `null` when no zone time was
 * accumulated. There is no low/ok/high band classification — the upstream
 * emits the bare percentage.
 *
 * Mirrors `sync.py:3154` line-by-line:
 *   round((z4_plus_time / total_zone_time) * 100, 1) if total_zone_time > 0 else None
 */
export function computeQualityIntensityPercentage(input: MetricInput): number | null {
  const activities7d = getActivitiesInWindow(getActivities(input), 7, input.frozenNow);
  const totals = aggregateZones(activities7d, DEFAULT_ZONE_PREFERENCE);

  if (totals.totalTime > 0) {
    return roundHalfEven((totals.z4PlusTime / totals.totalTime) * 100, 1);
  }
  return null;
}

/**
 * Static companion note the upstream emits alongside the quality-intensity
 * percentage. A constant string — mirrors `sync.py:3387` exactly.
 */
const QUALITY_INTENSITY_NOTE =
  "Quality Intensity % (Z4+/threshold+) - target ~20% in polarized training";

export function computeQualityIntensityNote(): string {
  return QUALITY_INTENSITY_NOTE;
}

/**
 * Easy-time ratio — the share of trailing-7-day zone time spent in Z1+Z2
 * (the "easy" work below LT1). Per Seiler's polarized model the target is
 * ~0.80. Unlike the grey-zone and quality-intensity metrics this is a bare
 * ratio, not a percentage: no ×100, rounded to 2 dp. Returns `null` when no
 * zone time was accumulated.
 *
 * Mirrors `sync.py:3159` line-by-line:
 *   round((z1_time + z2_time) / total_zone_time, 2) if total_zone_time > 0 else None
 */
export function computeEasyTimeRatio(input: MetricInput): number | null {
  const activities7d = getActivitiesInWindow(getActivities(input), 7, input.frozenNow);
  const totals = aggregateZones(activities7d, DEFAULT_ZONE_PREFERENCE);

  if (totals.totalTime > 0) {
    return roundHalfEven((totals.z1Time + totals.z2Time) / totals.totalTime, 2);
  }
  return null;
}

/**
 * Static companion note the upstream emits alongside the easy-time ratio.
 * A constant string — mirrors `sync.py:3389` exactly.
 */
const EASY_TIME_RATIO_NOTE =
  "Easy time (Z1+Z2) / Total - target ~80% in polarized training";

export function computeEasyTimeRatioNote(): string {
  return EASY_TIME_RATIO_NOTE;
}

/**
 * 7-day Seiler training-intensity distribution (TID).
 *
 * Folds the seven training zones into Seiler's three-zone model over the
 * trailing-7-day window (per Treff et al. 2019, *The Polarization-Index*,
 * Front. Physiol. 10:707, doi:10.3389/fphys.2019.00707):
 *   - Seiler Z1 = z1 + z2  (below LT1, "easy")
 *   - Seiler Z2 = z3       (between LT1 and LT2, "threshold/grey")
 *   - Seiler Z3 = z4 + z5 + z6 + z7  (above LT2, "hard")
 *
 * Emits the three zone-second totals, their percentage shares (round 1 dp),
 * the Treff polarization index (a `log10` score, `null` unless the
 * distribution is structurally polarized — see `calculatePolarizationIndex`),
 * the TID classification (Base / Polarized / Pyramidal / Threshold / High
 * Intensity), and the aggregate `zone_basis`. When no zone time accumulated
 * (`total_seconds == 0`) every percentage, the index, the classification, and
 * the basis are `null` while the second totals are `0`.
 *
 * Upstream source mirrored line-by-line: `sync.py:3993` (`_build_seiler_tid`,
 * called with `activities_7d` and no sport-family filter at `sync.py:3164`)
 * over `sync.py:3866` (`_aggregate_seiler_zones`), `sync.py:3930`
 * (`_calculate_polarization_index`) and `sync.py:3958` (`_classify_tid`).
 * The polarization index and classification are emitted as fields of this
 * metric, not as standalone metrics. See `NOTICE.md` for upstream attribution.
 *
 * Return shape is the raw upstream output, not a discriminated-union
 * envelope. Raw compute functions feed the parity gate; a sibling envelope
 * wrapper will feed the curator when the curator integration lands.
 */
export interface SeilerTid {
  z1_seconds: number;
  z2_seconds: number;
  z3_seconds: number;
  z1_pct: number | null;
  z2_pct: number | null;
  z3_pct: number | null;
  polarization_index: number | null;
  classification: string | null;
  zone_basis: "power" | "hr" | "mixed" | null;
}

export function computeSeilerTid(input: MetricInput): SeilerTid {
  const activities7d = getActivitiesInWindow(getActivities(input), 7, input.frozenNow);
  return buildSeilerTid(activities7d, null);
}

/**
 * 7-day Seiler TID restricted to the athlete's primary sport family.
 *
 * The primary sport is the family carrying the greatest accumulated Load
 * over the trailing-7-day window. With that family as the
 * `sport_family_filter`, only its activities enter the aggregation, while
 * each activity's own sport family still drives its zone-preference lookup
 * (the filter controls inclusion, not zone selection). The result is the
 * same shape as `seiler_tid_7d` plus a `sport` key naming the family.
 *
 * Returns `null` when there is no primary sport — i.e. no in-window
 * activity carries Load > 0, so the upstream `primary_sport` stays `None`
 * and the variant is never built.
 *
 * Upstream source mirrored line-by-line: the call site at `sync.py:3166-3171`
 * (`_build_seiler_tid(activities_7d, sport_family_filter=primary_sport)`
 * then `["sport"] = primary_sport`) over the same Seiler substrate as
 * `computeSeilerTid`. The `primary_sport` derivation mirrors `sync.py:3048-3056`
 * (`_get_daily_tss_by_sport` then `max(sport_totals, key=sport_totals.get)`).
 * See `NOTICE.md` for upstream attribution.
 */
export interface SeilerTidPrimary extends SeilerTid {
  sport: string;
}

export function computeSeilerTidPrimary(input: MetricInput): SeilerTidPrimary | null {
  const activities7d = getActivitiesInWindow(getActivities(input), 7, input.frozenNow);

  const primarySport = selectPrimarySport(activities7d);
  if (!primarySport) return null;

  return { ...buildSeilerTid(activities7d, primarySport), sport: primarySport };
}

/**
 * 28-day Seiler training-intensity distribution (TID) — the chronic window.
 *
 * Identical to `computeSeilerTid` in every respect except the aggregation
 * window: the same all-sport Seiler builder runs over the trailing 28 days
 * instead of 7. Pairing the acute (7d) and chronic (28d) distributions is
 * what lets the upstream detect intensity-distribution drift.
 *
 * Upstream source mirrored line-by-line: `sync.py:3184`
 * (`_build_seiler_tid(activities_28d)`, no sport-family filter), the same
 * builder (`sync.py:3993`) as the 7-day variant over the wider window. See
 * `NOTICE.md` for upstream attribution.
 */
export function computeSeilerTid28d(input: MetricInput): SeilerTid {
  const activities28d = getActivitiesInWindow(getActivities(input), 28, input.frozenNow);
  return buildSeilerTid(activities28d, null);
}

/**
 * 28-day Seiler TID restricted to the athlete's primary sport family — the
 * chronic-window counterpart to `computeSeilerTidPrimary`.
 *
 * The primary sport is still the family carrying the greatest accumulated
 * Load over the trailing-7-day window (the upstream derives it once from
 * `activities_7d`), but the Seiler aggregation runs over the wider 28-day
 * window with that family as the `sport_family_filter`. The result is the
 * same shape as `seiler_tid_28d` plus a `sport` key naming the family.
 *
 * Returns `null` when there is no primary sport — i.e. no in-window-7d
 * activity carries Load > 0, so the upstream `primary_sport` stays `None`
 * and the variant is never built.
 *
 * Upstream source mirrored line-by-line: the call site at `sync.py:3186-3191`
 * (`_build_seiler_tid(activities_28d, sport_family_filter=primary_sport)`
 * then `["sport"] = primary_sport`) over the same Seiler substrate as
 * `computeSeilerTid28d`. The `primary_sport` derivation mirrors
 * `sync.py:3048-3056` (`_get_daily_tss_by_sport(activities_7d, days=7)` then
 * `max(sport_totals, key=sport_totals.get)`). See `NOTICE.md` for upstream
 * attribution.
 */
export function computeSeilerTid28dPrimary(input: MetricInput): SeilerTidPrimary | null {
  const activities = getActivities(input);
  const activities7d = getActivitiesInWindow(activities, 7, input.frozenNow);
  const activities28d = getActivitiesInWindow(activities, 28, input.frozenNow);

  const primarySport = selectPrimarySport(activities7d);
  if (!primarySport) return null;

  return { ...buildSeilerTid(activities28d, primarySport), sport: primarySport };
}

// ─── Zone substrate ───────────────────────────────────────────────────
//
// Shared by every distribution-tier metric (grey-zone %, quality-intensity
// %, easy-time ratio, Seiler TID). Mirrors `_get_activity_zones` and
// `_aggregate_zones` line-by-line.

interface ZoneTotals {
  z1Time: number;
  z2Time: number;
  z3Time: number;
  z4PlusTime: number;
  totalTime: number;
  zoneBasis: "power" | "hr" | "mixed" | null;
}

// `self.zone_preference or {}` (sync.py:375). The parity harness
// instantiates the upstream without a preference, so the default is the
// power-preferred / HR-fallback path; the substrate still honours a
// per-sport-family `"hr"` preference when one is supplied.
const DEFAULT_ZONE_PREFERENCE: Record<string, string> = {};

const ZONE_IDS = new Set(["z1", "z2", "z3", "z4", "z5", "z6", "z7"]);
const ZONE_LABELS = ["z1", "z2", "z3", "z4", "z5", "z6", "z7"] as const;

// Aggregate per-activity zone times across the window. Mirrors
// `_aggregate_zones` (sync.py:3814): only activities that yield a non-empty
// zone dict contribute; `z4_plus` folds z4..z7; `total` sums every present
// zone value; the aggregate basis is "mixed" when both power- and HR-based
// activities appear, the single basis when only one does, else null.
function aggregateZones(
  activities: Activity[],
  zonePreference: Record<string, string>,
): ZoneTotals {
  let z1Time = 0;
  let z2Time = 0;
  let z3Time = 0;
  let z4PlusTime = 0;
  let totalTime = 0;
  const basisSet = new Set<string>();

  for (const act of activities) {
    // Object.hasOwn guards prototype-chain lookups: a fixture with
    // act.type === "toString"/"constructor" would otherwise resolve to an
    // inherited Function reference instead of falling through to null.
    const sportFamily = Object.hasOwn(SPORT_FAMILIES, act.type)
      ? SPORT_FAMILIES[act.type]
      : null;
    const { zones, basis } = getActivityZones(act, sportFamily, zonePreference);

    if (Object.keys(zones).length > 0) {
      if (basis) basisSet.add(basis);
      z1Time += zones.z1 ?? 0;
      z2Time += zones.z2 ?? 0;
      z3Time += zones.z3 ?? 0;
      z4PlusTime += (zones.z4 ?? 0) + (zones.z5 ?? 0) + (zones.z6 ?? 0) + (zones.z7 ?? 0);
      totalTime += pythonSum(Object.values(zones));
    }
  }

  let zoneBasis: "power" | "hr" | "mixed" | null;
  if (basisSet.size > 1) {
    zoneBasis = "mixed";
  } else if (basisSet.size === 1) {
    zoneBasis = basisSet.values().next().value as "power" | "hr";
  } else {
    zoneBasis = null;
  }

  return { z1Time, z2Time, z3Time, z4PlusTime, totalTime, zoneBasis };
}

// Extract one activity's zone times. Mirrors `_get_activity_zones`
// (sync.py:3683): power zones come from `icu_zone_times` (list of
// `{id, secs}`), HR zones from `icu_hr_zone_times` (flat seconds array
// indexed to z1..z7, skipping zero/empty bins). Default is power-preferred
// with HR fallback; a sport family configured for `"hr"` flips that.
function getActivityZones(
  activity: Activity,
  sportFamily: string | null,
  zonePreference: Record<string, string>,
): { zones: Record<string, number>; basis: "power" | "hr" | null } {
  const preferHr = sportFamily !== null && zonePreference[sportFamily] === "hr";

  // `icu_hr_zone_times` is not on the typed Activity surface (the schema
  // carries the object-form `hr_zone_times`); read both zone sets off the
  // raw fixture record the way the upstream `.get()` does.
  const raw = activity as Record<string, unknown>;

  let powerZones: Record<string, number> | null = null;
  const icuZoneTimes = raw.icu_zone_times;
  if (Array.isArray(icuZoneTimes) && icuZoneTimes.length > 0) {
    const pz: Record<string, number> = {};
    for (const zone of icuZoneTimes) {
      const obj =
        typeof zone === "object" && zone !== null
          ? (zone as { id?: unknown; secs?: unknown })
          : {};
      const zoneId = (typeof obj.id === "string" ? obj.id : "").toLowerCase();
      const secs = typeof obj.secs === "number" ? obj.secs : 0;
      if (ZONE_IDS.has(zoneId)) pz[zoneId] = secs;
    }
    if (Object.keys(pz).length > 0) powerZones = pz;
  }

  let hrZones: Record<string, number> | null = null;
  const icuHrZoneTimes = raw.icu_hr_zone_times;
  if (Array.isArray(icuHrZoneTimes) && icuHrZoneTimes.length > 0) {
    const hz: Record<string, number> = {};
    icuHrZoneTimes.forEach((secs, idx) => {
      // Mirror the power-zone guard above: coerce a non-numeric bin to 0 (then
      // skipped by the truthiness check) instead of storing it. icu_hr_zone_times
      // is read off the raw, unvalidated record, so a malformed string bin can
      // reach here — the upstream keeps it and raises on the later sum (an
      // unportable input the parity gate can't capture), but concatenating a
      // string into our running zone sums is strictly worse than dropping it.
      const numericSecs = typeof secs === "number" ? secs : 0;
      if (idx < ZONE_LABELS.length && numericSecs) {
        hz[ZONE_LABELS[idx]] = numericSecs;
      }
    });
    if (Object.keys(hz).length > 0) hrZones = hz;
  }

  if (preferHr) {
    if (hrZones) return { zones: hrZones, basis: "hr" };
    if (powerZones) return { zones: powerZones, basis: "power" };
  } else {
    if (powerZones) return { zones: powerZones, basis: "power" };
    if (hrZones) return { zones: hrZones, basis: "hr" };
  }

  return { zones: {}, basis: null };
}

// ─── Seiler TID substrate ─────────────────────────────────────────────
//
// The Seiler three-zone aggregation + Treff polarization index + TID
// classifier. Mirrors `_aggregate_seiler_zones`, `_calculate_polarization_index`,
// `_classify_tid` and `_build_seiler_tid` line-by-line. Note the Seiler
// aggregation defaults an unmapped/missing sport family to "other" (NOT
// `null`, as the seven-zone `_aggregate_zones` does) — this only changes
// the zone-preference lookup, which is inert under the harness's empty
// preference, but is mirrored faithfully because it is a distinct upstream
// function.

interface SeilerZoneTotals {
  z1Seconds: number;
  z2Seconds: number;
  z3Seconds: number;
  totalSeconds: number;
  zoneBasis: "power" | "hr" | "mixed" | null;
}

function aggregateSeilerZones(
  activities: Activity[],
  sportFamilyFilter: string | null,
): SeilerZoneTotals {
  let sz1 = 0;
  let sz2 = 0;
  let sz3 = 0;
  const basisSet = new Set<string>();

  for (const act of activities) {
    const activityType = act.type ?? "Unknown";
    const actSportFamily = Object.hasOwn(SPORT_FAMILIES, activityType)
      ? SPORT_FAMILIES[activityType]
      : "other";
    if (sportFamilyFilter) {
      if (actSportFamily !== sportFamilyFilter) continue;
    }

    const { zones, basis } = getActivityZones(act, actSportFamily, DEFAULT_ZONE_PREFERENCE);

    if (Object.keys(zones).length > 0) {
      if (basis) basisSet.add(basis);
      sz1 += (zones.z1 ?? 0) + (zones.z2 ?? 0);
      sz2 += zones.z3 ?? 0;
      sz3 += (zones.z4 ?? 0) + (zones.z5 ?? 0) + (zones.z6 ?? 0) + (zones.z7 ?? 0);
    }
  }

  const totalSeconds = sz1 + sz2 + sz3;

  let zoneBasis: "power" | "hr" | "mixed" | null;
  if (basisSet.size > 1) {
    zoneBasis = "mixed";
  } else if (basisSet.size === 1) {
    zoneBasis = basisSet.values().next().value as "power" | "hr";
  } else {
    zoneBasis = null;
  }

  return { z1Seconds: sz1, z2Seconds: sz2, z3Seconds: sz3, totalSeconds, zoneBasis };
}

// Treff Polarization Index: PI = log10((Z1 / Z2) × Z3 × 100). Computed only
// when the distribution is structurally polarized (Z1 > Z3 > Z2 and
// Z3 >= 0.01); Z2 = 0 is substituted with 0.01. Mirrors `sync.py:3930`.
function calculatePolarizationIndex(
  z1Frac: number,
  z2Frac: number,
  z3Frac: number,
): number | null {
  if (z3Frac < 0.01) return null;
  if (!(z1Frac > z3Frac && z3Frac > z2Frac)) return null;

  const effectiveZ2 = z2Frac > 0 ? z2Frac : 0.01;

  const raw = (z1Frac / effectiveZ2) * z3Frac * 100;
  if (raw <= 0) return null;
  // `raw` is built from `× ÷` only — correctly-rounded IEEE-754, so identical
  // across runtimes — but `log10` is the one transcendental in the metric path
  // and the only op here NOT bit-identical to the oracle by construction. It is
  // not correctly-rounded by IEEE-754: V8's `Math.log10` and the oracle's libm
  // (Pyodide/emscripten) are different implementations free to disagree in the
  // last ULP. A disagreement that straddles a 2-dp midpoint flips the emitted
  // PI and — through `pi > 2.0` in `classifyTid` — the Polarized/Pyramidal
  // label. The measure is ~1e-14 per call (the 1-ULP split must land on an
  // X.XX5 boundary), so unlike sum/stdev/round (reproduced exact-rationally in
  // `statistics.ts` / `rounding.ts`) this residual is deliberately accepted:
  // reproducing the oracle's exact libm log10 is ~200 lines of version-pinned,
  // table-driven musl transliteration re-verified on every Pyodide bump — not
  // worth closing a ~1e-14 gap. The tolerance-zero gate is the safety net: if a
  // fixture ever lands on the boundary it turns red HERE (caught in CI, never
  // shipped silently), and the fix is then to regenerate that snapshot or
  // reproduce the exact log10. A "more accurate" log10 would diverge MORE, not
  // less — the target is the oracle's bits, not correctness.
  return roundHalfEven(Math.log10(raw), 2);
}

// TID classification with the upstream's explicit priority order to avoid
// overlaps. Mirrors `sync.py:3958`.
function classifyTid(
  z1Frac: number,
  z2Frac: number,
  z3Frac: number,
  pi: number | null,
): string {
  if (z3Frac < 0.01 && z1Frac >= z2Frac && z1Frac >= z3Frac) return "Base";
  if (z1Frac > z3Frac && z3Frac > z2Frac && pi !== null && pi > 2.0) return "Polarized";
  if (z1Frac > z2Frac && z2Frac > z3Frac) return "Pyramidal";
  if (z2Frac >= z1Frac && z2Frac >= z3Frac) return "Threshold";
  if (z3Frac >= z1Frac && z3Frac >= z2Frac) return "High Intensity";
  return "Pyramidal";
}

// Build the complete Seiler TID structure. Mirrors `sync.py:3993`.
function buildSeilerTid(
  activities: Activity[],
  sportFamilyFilter: string | null,
): SeilerTid {
  const zones = aggregateSeilerZones(activities, sportFamilyFilter);
  const total = zones.totalSeconds;
  const zoneBasis = zones.zoneBasis;

  if (total === 0) {
    return {
      z1_seconds: 0,
      z2_seconds: 0,
      z3_seconds: 0,
      z1_pct: null,
      z2_pct: null,
      z3_pct: null,
      polarization_index: null,
      classification: null,
      zone_basis: null,
    };
  }

  const z1Frac = zones.z1Seconds / total;
  const z2Frac = zones.z2Seconds / total;
  const z3Frac = zones.z3Seconds / total;

  const pi = calculatePolarizationIndex(z1Frac, z2Frac, z3Frac);
  const classification = classifyTid(z1Frac, z2Frac, z3Frac, pi);

  return {
    z1_seconds: zones.z1Seconds,
    z2_seconds: zones.z2Seconds,
    z3_seconds: zones.z3Seconds,
    z1_pct: roundHalfEven(z1Frac * 100, 1),
    z2_pct: roundHalfEven(z2Frac * 100, 1),
    z3_pct: roundHalfEven(z3Frac * 100, 1),
    polarization_index: pi,
    classification,
    zone_basis: zoneBasis,
  };
}

// Primary sport family = the family with the greatest accumulated Load over
// the window. Mirrors the inline derivation at `sync.py:3048-3056` over
// `_get_daily_tss_by_sport` (`sync.py:3646-3675`): Load is bucketed per
// (sport family, date) in activity order (skipping rows with Load <= 0,
// unmapped types grouped as "other"), each family's daily buckets are then
// summed and `max(sport_totals, key=sport_totals.get)` picks the largest.
// Float addition is non-associative, so the per-date bucketing is reproduced
// rather than collapsed to a flat per-family sum — that keeps the argmax
// input bit-identical at a near-tie. The absent window days the upstream sums
// as 0 are a no-op (`x + 0 === x`), so iterating only the present dates in
// ascending order matches `sum(daily_array)` exactly. `max` returns the first
// key at the maximum in dict-insertion order, so families are tracked in
// first-encountered order and ties resolve to the earliest. Returns `null`
// when no in-window activity carries Load > 0 (upstream `primary_sport` is
// `None`).
function selectPrimarySport(activities: Activity[]): string | null {
  const loadByFamilyDate = new Map<string, Map<string, number>>();

  for (const act of activities) {
    // `|| 0` maps a hypothetical NaN load to 0 (skipped); the upstream `or 0`
    // would keep it (NaN <= 0 is False). Unreachable divergence: z.number()
    // rejects NaN at the schema boundary, so a NaN load never reaches here.
    const load = act.icu_training_load || 0;
    if (load <= 0) continue;
    const date =
      typeof act.start_date_local === "string" ? act.start_date_local.slice(0, 10) : "";
    const activityType = act.type ?? "Unknown";
    const sportFamily = Object.hasOwn(SPORT_FAMILIES, activityType)
      ? SPORT_FAMILIES[activityType]
      : "other";
    let byDate = loadByFamilyDate.get(sportFamily);
    if (!byDate) {
      byDate = new Map();
      loadByFamilyDate.set(sportFamily, byDate);
    }
    byDate.set(date, (byDate.get(date) ?? 0) + load);
  }

  let primary: string | null = null;
  let maxTotal = -Infinity;
  for (const [sport, byDate] of loadByFamilyDate) {
    const total = pythonSum([...byDate.keys()].sort().map((date) => byDate.get(date) as number));
    if (total > maxTotal) {
      maxTotal = total;
      primary = sport;
    }
  }
  return primary;
}

// The trailing 7-day activity window the upstream reads as `activities_7d`:
// rows whose `start_date_local` date falls in [frozenNow-(days-1),
// frozenNow], inclusive, in fixture order. Mirrors the harness
// `_within(_activities_all, "start_date_local", ...)` slice — an inclusive
// lexicographic date comparison over the YYYY-MM-DD prefix.
export function getActivitiesInWindow(
  activities: Activity[],
  days: number,
  frozenNow: string,
): Activity[] {
  const oldest = isoDateDaysBefore(frozenNow, days - 1);
  const today = frozenNow.slice(0, 10);
  return activities.filter((a) => {
    if (typeof a.start_date_local !== "string") return false;
    const d = a.start_date_local.slice(0, 10);
    return oldest <= d && d <= today;
  });
}

