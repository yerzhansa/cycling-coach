/**
 * Reference layer — power-model scalar passthroughs.
 *
 * The upstream carries six live power-model estimates straight from
 * today's wellness row: eFTP, W', W'-in-kJ, P-max, the source label, and
 * VO2max. They are not computed from the activity stream — they are the
 * accurate live estimates the API already publishes (matching the
 * intervals.icu UI). The upstream extracts them via
 * `_extract_power_model_from_wellness(today_wellness)` and reads
 * `vo2max = today_wellness.get("vo2max")` (sync.py extraction +
 * the `_calculate_derived_metrics` output keys).
 *
 * `today_wellness` is the LATEST wellness row inside the 28-day window
 * (the same row the harness designates as `today_wellness`). The harness
 * gates the whole live-power-model pipeline on the fixture's `athlete`
 * key: absent athlete → empty power model + null vo2max. This module
 * mirrors that gate, then mirrors the extraction's truthiness +
 * rounding line-by-line.
 *
 * Each scalar ports as its own compute function (one-metric-one-file
 * oracle), all delegating to the shared extraction so the truthiness and
 * rounding live in one place.
 *
 * See `NOTICE.md` for upstream attribution.
 */

import {
  getAthlete,
  getWellness,
  type MetricInput,
} from "./metric-input.js";
import { isoDateDaysBefore } from "./date-helpers.js";
import { roundHalfEven } from "./rounding.js";
import type { WellnessDay } from "../schemas/inputs.js";

/** The dict shape `_extract_power_model_from_wellness` returns. Source is
 *  `"wellness.sportInfo"` when a Ride sportInfo row is found, `"unavailable"`
 *  otherwise; the harness designates an absent-athlete fixture's power model
 *  as `{}`, so the consumed `.get(...)` keys resolve to null for those. */
export interface PowerModel {
  eftp: number | null;
  w_prime: number | null;
  w_prime_kj: number | null;
  p_max: number | null;
  source: string;
}

// One per-sport entry in a wellness row's `sportInfo` array. The rows ride
// through the loose WellnessDay schema, so the field is read off the row's
// index signature and narrowed here.
interface SportInfoEntry {
  type?: unknown;
  eftp?: unknown;
  wPrime?: unknown;
  pMax?: unknown;
}

// Python truthiness over the value `round(...)` guards on: 0 and None (here
// null/undefined/NaN) are falsy, every other finite number is truthy.
function isTruthyNumber(v: unknown): v is number {
  return typeof v === "number" && v !== 0 && !Number.isNaN(v);
}

// `_extract_power_model_from_wellness(wellness_data)` (sync.py). Finds the
// first `type == "Ride"` sportInfo dict, reads camelCase eftp/wPrime/pMax,
// and rounds each under Python's `round`: `round(eftp, 1)` (1 decimal),
// `round(w_prime)` / `round(p_max)` (single-arg → nearest integer),
// `round(w_prime / 1000, 1)` (1 decimal). The `if <value>` guards mirror
// Python truthiness, so a 0 or absent value yields null.
function extractPowerModelFromWellness(row: WellnessDay): PowerModel {
  const sportInfo = ((row as { sportInfo?: unknown }).sportInfo ?? []) as
    | SportInfoEntry[];

  let cyclingInfo: SportInfoEntry | null = null;
  for (const sport of Array.isArray(sportInfo) ? sportInfo : []) {
    if (sport && typeof sport === "object" && sport.type === "Ride") {
      cyclingInfo = sport;
      break;
    }
  }

  if (!cyclingInfo) {
    return {
      eftp: null,
      w_prime: null,
      w_prime_kj: null,
      p_max: null,
      source: "unavailable",
    };
  }

  const eftp = cyclingInfo.eftp;
  const wPrime = cyclingInfo.wPrime;
  const pMax = cyclingInfo.pMax;

  return {
    eftp: isTruthyNumber(eftp) ? roundHalfEven(eftp, 1) : null,
    w_prime: isTruthyNumber(wPrime) ? roundHalfEven(wPrime, 0) : null,
    w_prime_kj: isTruthyNumber(wPrime) ? roundHalfEven(wPrime / 1000, 1) : null,
    p_max: isTruthyNumber(pMax) ? roundHalfEven(pMax, 0) : null,
    source: "wellness.sportInfo",
  };
}

// The harness's `today_wellness`: the latest wellness row whose `id[:10]`
// falls in the 28-day window [frozenNow-27, frozenNow], chosen by sorting
// the in-window rows by `id` string descending and taking the first. Returns
// null when no row qualifies — the harness's `_pick_latest_wellness(...) or {}`
// empty case, which `_extract_power_model_from_wellness` then sees as a row
// with no sportInfo (source "unavailable") and `vo2max` as null.
function selectTodayWellness(input: MetricInput): WellnessDay | null {
  const today = input.frozenNow.slice(0, 10);
  const oldest = isoDateDaysBefore(input.frozenNow, 27);

  const inWindow = getWellness(input).filter((row) => {
    if (typeof row.id !== "string") return false;
    const d = row.id.slice(0, 10);
    return oldest <= d && d <= today;
  });
  if (inWindow.length === 0) return null;

  let latest = inWindow[0]!;
  for (const row of inWindow) {
    if ((row.id ?? "") > (latest.id ?? "")) latest = row;
  }
  return latest;
}

// The power model the upstream consumes for this fixture, or null to signal
// the harness's empty-dict (`power_model = {}`) state. Mirrors the harness
// gate: only when the fixture carries `athlete` does the live pipeline run.
// Absent athlete → null (so every consumed `.get(...)` key resolves to null).
// Present athlete but no in-window wellness → the empty-row extraction
// (source "unavailable", scalars null), matching `_extract_power_model_from_wellness({})`.
export function resolvePowerModel(input: MetricInput): PowerModel | null {
  if (getAthlete(input) === null) return null;
  const today = selectTodayWellness(input);
  if (today === null) {
    return {
      eftp: null,
      w_prime: null,
      w_prime_kj: null,
      p_max: null,
      source: "unavailable",
    };
  }
  return extractPowerModelFromWellness(today);
}

export function computeEftp(input: MetricInput): number | null {
  return resolvePowerModel(input)?.eftp ?? null;
}

export function computeWPrime(input: MetricInput): number | null {
  return resolvePowerModel(input)?.w_prime ?? null;
}

export function computeWPrimeKj(input: MetricInput): number | null {
  return resolvePowerModel(input)?.w_prime_kj ?? null;
}

export function computePMax(input: MetricInput): number | null {
  return resolvePowerModel(input)?.p_max ?? null;
}

export function computePowerModelSource(input: MetricInput): string | null {
  return resolvePowerModel(input)?.source ?? null;
}

// `vo2max = today_wellness.get("vo2max")`, gated on the same `athlete` key as
// the power model (absent athlete → null in the harness). Read off the loose
// wellness row; an absent/null field passes through as null.
export function computeVo2max(input: MetricInput): number | null {
  if (getAthlete(input) === null) return null;
  const today = selectTodayWellness(input);
  if (today === null) return null;
  return today.vo2max ?? null;
}
