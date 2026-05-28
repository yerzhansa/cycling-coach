import type { Activity, PlannedEvent } from "../schemas/inputs.js";

/**
 * The contract between a metric port and the parity gate.
 *
 * The gate (`tools/check-metric-parity.ts`) loads each metric's snapshot,
 * resolves the registry entry to a function in this directory, and calls
 * it with this input shape. `frozenNow` matches the snapshot's
 * `frozen_now` field so the metric can derive date-relative windows that
 * line up with the captured oracle.
 */
export interface MetricInput {
  fixture: unknown;
  frozenNow: string;
}

// Fixtures are trusted at the gate boundary; this helper does not
// re-validate (Zod ran upstream of the snapshot capture). When a wellness
// metric joins the port (e.g. recovery_index), add a sibling
// `getWellness(input)` the same way rather than widening this one.
export function getActivities(input: MetricInput): Activity[] {
  const fixture = input.fixture as { activities?: Activity[] };
  return fixture.activities ?? [];
}

export function getPastEvents(input: MetricInput): PlannedEvent[] {
  const fixture = input.fixture as { past_events?: PlannedEvent[] };
  return fixture.past_events ?? [];
}

export function getCurrentFtpIndoor(input: MetricInput): number | null {
  const fixture = input.fixture as { current_ftp_indoor?: number | null };
  return fixture.current_ftp_indoor ?? null;
}

export function getFtpHistoryIndoor(
  input: MetricInput,
): Record<string, number> {
  const fixture = input.fixture as {
    ftp_history_indoor?: Record<string, number>;
  };
  return fixture.ftp_history_indoor ?? {};
}

export function getCurrentFtpOutdoor(input: MetricInput): number | null {
  const fixture = input.fixture as { current_ftp_outdoor?: number | null };
  return fixture.current_ftp_outdoor ?? null;
}

export function getFtpHistoryOutdoor(
  input: MetricInput,
): Record<string, number> {
  const fixture = input.fixture as {
    ftp_history_outdoor?: Record<string, number>;
  };
  return fixture.ftp_history_outdoor ?? {};
}
