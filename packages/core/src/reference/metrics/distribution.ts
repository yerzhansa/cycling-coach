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

import { getActivities, type MetricInput } from "./metric-input.js";

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

// Mirrors `SPORT_FAMILIES` at sync.py:290-308. In `_aggregate_zones` the
// lookup defaults to `None` for unmapped types (NOT "other"), so an
// unmapped type yields no `prefer_hr` and rides the power-preferred path.
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
      for (const v of Object.values(zones)) totalTime += v;
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
      if (idx < ZONE_LABELS.length && secs) {
        hz[ZONE_LABELS[idx]] = secs as number;
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

// The trailing 7-day activity window the upstream reads as `activities_7d`:
// rows whose `start_date_local` date falls in [frozenNow-(days-1),
// frozenNow], inclusive, in fixture order. Mirrors the harness
// `_within(_activities_all, "start_date_local", ...)` slice — an inclusive
// lexicographic date comparison over the YYYY-MM-DD prefix.
function getActivitiesInWindow(
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
// bit-identical on any zone-hours value that lands at the boundary.
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
