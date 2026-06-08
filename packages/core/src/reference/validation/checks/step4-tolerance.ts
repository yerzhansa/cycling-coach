/**
 * Step 4 (HARD): present numeric fields fall inside physiologically plausible
 * bands. Maps to the upstream protocol's tolerance-band check. See `NOTICE.md`
 * for license attribution.
 */
import type { FetchedReference } from "../../sync/run-sync.js";
import type { CheckResult, GateFailure } from "../sync-gate.js";
import { collectFtpValues } from "./step1-ftp-source.js";

interface Band {
  readonly field: string;
  readonly lo: number;
  readonly hi: number;
}

const BANDS: Readonly<Record<string, Band>> = {
  weight: { field: "weight", lo: 30, hi: 200 },
  ftp: { field: "ftp", lo: 50, hi: 600 },
  hr: { field: "hr", lo: 30, hi: 220 },
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function checkBand(
  band: Band,
  value: unknown,
  failures: GateFailure[],
): void {
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  if (value < band.lo || value > band.hi) {
    failures.push({
      step: "step4_tolerance_band",
      detail: `${band.field}=${value} out of band [${band.lo},${band.hi}]`,
    });
  }
}

function checkNonNegative(
  field: string,
  value: unknown,
  failures: GateFailure[],
): void {
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  if (value < 0) {
    failures.push({
      step: "step4_tolerance_band",
      detail: `${field}=${value} out of band [0,Infinity]`,
    });
  }
}

export function checkTolerance(fetched: FetchedReference): CheckResult {
  const failures: GateFailure[] = [];

  for (const ftp of collectFtpValues(fetched)) {
    checkBand(BANDS.ftp, ftp, failures);
  }

  const wellness = asRecord(fetched?.latest?.wellness_data);
  const wellnessRows: unknown[] = wellness !== null && Array.isArray(wellness.days)
    ? wellness.days
    : Array.isArray(fetched?.latest?.wellness_data)
      ? (fetched.latest.wellness_data as unknown[])
      : wellness !== null
        ? [wellness]
        : [];
  for (const row of wellnessRows) {
    const r = asRecord(row);
    if (r === null) continue;
    checkBand(BANDS.weight, r.weight, failures);
    checkBand(BANDS.hr, r.restingHR, failures);
  }

  const activities = fetched?.latest?.recent_activities;
  if (Array.isArray(activities)) {
    for (const a of activities) {
      const r = asRecord(a);
      if (r === null) continue;
      checkBand(BANDS.hr, r.average_heartrate, failures);
      checkNonNegative("moving_time", r.moving_time, failures);
      checkNonNegative("elapsed_time", r.elapsed_time, failures);
      checkNonNegative("icu_training_load", r.icu_training_load, failures);
    }
  }

  return { failures, warnings: [] };
}
