/**
 * Step 5 (HARD): the running critical-speed (CS) anchor is resolvable and sane.
 * Pace zones derive entirely from CS, so a missing-or-corrupt anchor must not
 * sync into a zone table. The manual override (`critical_speed`) outranks the
 * platform value (`threshold_pace`); both are SI metres-per-second. Sibling of
 * the FTP-source gate (step 1); the swim CSS gate will follow the same shape.
 */
import type { FetchedReference } from "../../sync/run-sync.js";
import type { CheckResult, GateFailure } from "../sync-gate.js";
import { collectRunCsRows, CS_MIN_MPS, CS_MAX_MPS } from "../../cs-resolution.js";

/**
 * Collect the running CS anchors the athlete profile exposes, split by source:
 * `manual` from `sportSettings[*].critical_speed`, `platform` from `.threshold_pace`,
 * for rows whose `types` intersect the running family. Reuses the shared row-walk
 * (`collectRunCsRows`) so this gate validates exactly the fields the runtime
 * resolver (`resolveRunningCs`) reads back — the two cannot drift. Returns empty
 * lists when no running row (or no CS field) is present (RESOLVE-OR-SKIP: a
 * cyclist with no Run activity must not hard-fail).
 */
export function collectCsValues(fetched: FetchedReference): {
  manual: number[];
  platform: number[];
} {
  const rows = collectRunCsRows(fetched?.latest?.athlete_profile);
  const manual = rows.map((r) => r.criticalSpeed).filter((v): v is number => v !== null);
  const platform = rows.map((r) => r.thresholdPace).filter((v): v is number => v !== null);
  return { manual, platform };
}

export function checkCsSource(fetched: FetchedReference): CheckResult {
  const { manual, platform } = collectCsValues(fetched);

  // Manual outranks platform: when an override is present, validate it and
  // ignore the platform value's validity entirely.
  const values = manual.length > 0 ? manual : platform;
  if (values.length === 0) return { failures: [], warnings: [] };

  const failures: GateFailure[] = [];
  for (const value of values) {
    if (!Number.isFinite(value) || value <= 0 || value < CS_MIN_MPS || value > CS_MAX_MPS) {
      failures.push({
        step: "step5_cs_source",
        detail: `Critical-speed source present but outside the sane [${CS_MIN_MPS}, ${CS_MAX_MPS}] m/s band: ${value}`,
      });
    }
  }

  return { failures, warnings: [] };
}
