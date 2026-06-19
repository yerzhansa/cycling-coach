/**
 * Layer-1 sync gate. Runs seven mechanical checks over a freshly-fetched
 * Reference bundle before its cache files are committed: five HARD checks
 * (any failure rejects the sync) and two SOFT checks (annotations that ride
 * through as warnings without blocking the write).
 *
 * Checks read the upstream protocol's source fields. See `NOTICE.md` for
 * license attribution.
 *
 * The call site already exists in `runSync()` (between fetch and cache-file
 * writes); this body fills in the previously-stubbed gate.
 */
import type { FetchedReference } from "../sync/run-sync.js";
import type { LatestJson } from "../schemas/latest.js";
import type { Freshness } from "../sync/freshness-check.js";

import { checkDataFetch } from "./checks/step0-data-fetch.js";
import { checkFtpSource } from "./checks/step1-ftp-source.js";
import { checkWeeklyHours } from "./checks/step2-weekly-hours.js";
import { checkTolerance } from "./checks/step4-tolerance.js";
import { checkCsSource } from "./checks/step5-cs-source.js";
import { checkFreshness } from "./checks/step6-freshness-24h.js";
import { checkClockOffset } from "./checks/step6b-clock-offset.js";
import { checkMultiMetricConflict } from "./checks/step7-multi-metric-conflict.js";

export type GateStep =
  | "step0_data_fetch"
  | "step1_ftp_source"
  | "step2_weekly_hours_consistency"
  | "step4_tolerance_band"
  | "step5_cs_source"
  | "step6_freshness_24h"
  | "step6b_clock_offset"
  | "step7_multi_metric_conflict";

export interface GateFailure {
  readonly step: GateStep;
  readonly detail: string;
}

export interface GateWarning {
  readonly step: GateStep;
  readonly detail: string;
}

/** A single check's contribution to the aggregate gate result. */
export interface CheckResult {
  readonly failures: readonly GateFailure[];
  readonly warnings: readonly GateWarning[];
}

export interface GateResult {
  readonly ok: boolean;
  readonly failures: readonly GateFailure[];
  readonly warnings: readonly GateWarning[];
  /**
   * Freshness band derived by the step-6 annotator. `runSync()` writes it to
   * `latest.json.metadata.freshness` so the gate is the single source for the
   * band rather than the orchestrator hardcoding `"fresh"`.
   */
  readonly freshness?: Freshness;
}

export function gateLatestJson(
  fetched: FetchedReference,
  _prior: LatestJson | null,
  now: Date = new Date(),
): GateResult {
  const freshnessResult = checkFreshness(fetched, now);

  const results: readonly CheckResult[] = [
    checkDataFetch(fetched),
    checkFtpSource(fetched),
    checkWeeklyHours(fetched),
    checkTolerance(fetched),
    checkCsSource(fetched),
    freshnessResult,
    checkClockOffset(fetched, now),
    checkMultiMetricConflict(fetched),
  ];

  const failures = results.flatMap((r) => r.failures);
  const warnings = results.flatMap((r) => r.warnings);

  return {
    ok: failures.length === 0,
    failures,
    warnings,
    freshness: freshnessResult.freshness,
  };
}
