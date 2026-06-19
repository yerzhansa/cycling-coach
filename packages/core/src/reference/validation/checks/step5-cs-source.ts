/**
 * Step 5 (HARD): the running critical-speed (CS) anchor is resolvable and sane.
 * Pace zones derive entirely from CS, so a missing-or-corrupt anchor must not
 * sync into a zone table. The manual override (`critical_speed`) outranks the
 * platform value (`threshold_pace`); both are SI metres-per-second. Sibling of
 * the FTP-source gate (step 1); the swim CSS gate will follow the same shape.
 */
import type { FetchedReference } from "../../sync/run-sync.js";
import type { CheckResult, GateFailure } from "../sync-gate.js";

// intervals.icu running-family activity types. Kept to the set the running sport
// actually declares (Run, TrailRun); VirtualRun is intentionally excluded — it is
// not in core's IntervalsActivityType union this wave, so admitting it would
// validate rows the sport never claims to handle. Inlined (not imported from the
// metrics layer's module-private SPORT_FAMILIES) so the gate stays self-contained,
// mirroring how collectFtpValues walks rows directly.
const RUN_FAMILY_TYPES = new Set(["Run", "TrailRun"]);

// Hard-refusal CS band in m/s: a value outside is unit-confused or corrupt, not a
// real CS. The typical recreational-to-trained range (~2.5–6.0 m/s, ≈6:40–2:47/km)
// sits inside; the [2.0, 6.5] edges add headroom before refusing. Kept in sync
// with the sport-running CS_SANITY_MPS constant.
const CS_MIN_MPS = 2.0;
const CS_MAX_MPS = 6.5;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Collect the running CS anchors the athlete profile exposes, split by source:
 * `manual` from `sportSettings[*].critical_speed`, `platform` from
 * `.threshold_pace`, for rows whose `types` intersect the running family.
 * Returns empty lists when no running row (or no CS field) is present
 * (RESOLVE-OR-SKIP: a cyclist with no Run activity must not hard-fail).
 */
export function collectCsValues(fetched: FetchedReference): {
  manual: number[];
  platform: number[];
} {
  const manual: number[] = [];
  const platform: number[] = [];

  const profile = asRecord(fetched?.latest?.athlete_profile);
  if (profile === null) return { manual, platform };

  const sportSettings = profile.sportSettings;
  if (Array.isArray(sportSettings)) {
    for (const row of sportSettings) {
      const r = asRecord(row);
      if (r === null) continue;
      const types = r.types;
      if (!Array.isArray(types)) continue;
      const isRun = types.some((t) => typeof t === "string" && RUN_FAMILY_TYPES.has(t));
      if (!isRun) continue;
      if (typeof r.critical_speed === "number") manual.push(r.critical_speed);
      if (typeof r.threshold_pace === "number") platform.push(r.threshold_pace);
    }
  }

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
