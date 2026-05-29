import type {
  Activity,
  FixtureShape,
  PlannedEvent,
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
