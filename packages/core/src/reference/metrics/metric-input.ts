import type {
  Activity,
  AthleteSettings,
  FixtureShape,
  PlannedEvent,
  PowerCurveData,
  WellnessDay,
} from "../schemas/inputs.js";
import { isoDateDaysBefore } from "./date-helpers.js";

/** Per-activity intervals entry projected to the fields the Reference layer
 *  consumes. Mirrors the upstream's intervals.json row shape (a distinct API
 *  surface from `activities`). The `intervals` sub-array can be absent, empty,
 *  or carry segments with `type` strings like `"WORK"` / `"RECOVERY"`. */
export interface IntervalsEntry {
  intervals?: { type: string }[];
}
export type IntervalsLookup = Record<string, IntervalsEntry>;

/**
 * The contract between a metric port and the parity gate.
 *
 * `fixture` is typed via `FixtureSchema` (parsed at the gate boundary
 * in `tools/check-metric-parity.ts`), so metrics receive a validated
 * shape instead of `unknown`. Accessors here are typed dot-access
 * thin wrappers — kept as named exports so call sites remain readable
 * (`getActivities(input)` over `input.fixture.activities`) and to give
 * a stable surface to mock in unit tests.
 *
 * `frozenNow` matches the snapshot's `frozen_now` field so the metric
 * can derive date-relative windows that line up with the captured
 * oracle.
 */
export interface MetricInput {
  fixture: FixtureShape;
  frozenNow: string;
}

export function getActivities(input: MetricInput): Activity[] {
  return input.fixture.activities;
}

// The trailing activity window the upstream reads as `activities_7d` /
// `activities_28d`: rows whose `start_date_local` date falls in
// [frozenNow-(days-1), frozenNow], inclusive, in fixture order. Mirrors the
// harness `slice_window(_activities_all, "start_date_local", ...)` — an
// inclusive lexicographic date comparison over the YYYY-MM-DD prefix.
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

export function getPastEvents(input: MetricInput): PlannedEvent[] {
  return input.fixture.past_events ?? [];
}

export function getCurrentFtpIndoor(input: MetricInput): number | null {
  return input.fixture.current_ftp_indoor ?? null;
}

export function getFtpHistoryIndoor(
  input: MetricInput,
): Record<string, number> {
  return input.fixture.ftp_history_indoor ?? {};
}

export function getCurrentFtpOutdoor(input: MetricInput): number | null {
  return input.fixture.current_ftp_outdoor ?? null;
}

export function getFtpHistoryOutdoor(
  input: MetricInput,
): Record<string, number> {
  return input.fixture.ftp_history_outdoor ?? {};
}

// Cast narrows Zod's looseObject ride-through inference to the named
// IntervalsEntry surface; the schema already validates the shape.
export function getIntervalsLookup(input: MetricInput): IntervalsLookup {
  return (input.fixture.intervals ?? {}) as IntervalsLookup;
}

/** Trailing-28d wellness rows in fixture order. Weight-signal callers
 *  filter by date internally — no slicing happens here. */
export function getWellnessExtendedWeight(input: MetricInput): WellnessDay[] {
  return input.fixture.wellness;
}

// Top-level eFTP fallback for `_build_weight_signal`'s FTP source
// resolution when tested outdoor FTP is null. See FixtureSchema.eftp.
export function getEftp(input: MetricInput): number | null {
  return input.fixture.eftp ?? null;
}

// The athlete-settings carrier. In the snapshot harness this key's
// presence gates the live power-model pipeline: only when the fixture
// carries `athlete` does the harness run `_extract_power_model_from_wellness`
// against the latest wellness row and read its `vo2max`; absent athlete →
// empty power model + null vo2max (the prior stub). Mirror that gate by
// keying the power-model passthroughs on this accessor returning non-null.
export function getAthlete(input: MetricInput): AthleteSettings | null {
  return input.fixture.athlete ?? null;
}

// Full wellness array, in fixture order. Power-model passthroughs select
// the latest row within the 28-day window from this surface.
export function getWellness(input: MetricInput): WellnessDay[] {
  return input.fixture.wellness;
}

// The `{list}` power mean-max curve envelope the upstream fetches and passes
// as the `power_curve_data` kwarg. Its presence gates the delta window math:
// the harness derives `power_curve_dates` from frozenNow ONLY when this key
// is present, so absent curves reproduce the null block without window keys.
export function getPowerCurves(input: MetricInput): PowerCurveData | null {
  return input.fixture.power_curves ?? null;
}
