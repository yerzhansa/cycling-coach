/**
 * Step 1 (HARD): FTP is resolvable and positive from the athlete profile.
 * Maps to the upstream protocol's FTP-source precondition. See `NOTICE.md`
 * for license attribution.
 */
import type { FetchedReference } from "../../sync/run-sync.js";
import type { CheckResult, GateFailure } from "../sync-gate.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Collect every FTP-bearing value the athlete profile exposes, in either the
 * `sportSettings[*].ftp` / `.indoor_ftp` shape or the
 * `thresholds.sports.<family>.ftp` shape. Returns an empty list when no FTP
 * source is present (RESOLVE-OR-SKIP: a profile that ships no FTP source must
 * not hard-fail — the pre-cutover fetcher returns an empty stub).
 */
export function collectFtpValues(fetched: FetchedReference): number[] {
  const profile = asRecord(fetched?.latest?.athlete_profile);
  if (profile === null) return [];

  const values: number[] = [];

  const sportSettings = profile.sportSettings;
  if (Array.isArray(sportSettings)) {
    for (const row of sportSettings) {
      const r = asRecord(row);
      if (r === null) continue;
      if (typeof r.ftp === "number") values.push(r.ftp);
      if (typeof r.indoor_ftp === "number") values.push(r.indoor_ftp);
    }
  }

  const thresholds = asRecord(profile.thresholds);
  const sports = thresholds === null ? null : asRecord(thresholds.sports);
  if (sports !== null) {
    for (const family of Object.values(sports)) {
      const f = asRecord(family);
      if (f !== null && typeof f.ftp === "number") values.push(f.ftp);
    }
  }

  return values;
}

export function checkFtpSource(fetched: FetchedReference): CheckResult {
  const values = collectFtpValues(fetched);
  if (values.length === 0) return { failures: [], warnings: [] };

  const failures: GateFailure[] = [];
  for (const value of values) {
    if (!Number.isFinite(value) || value <= 0) {
      failures.push({
        step: "step1_ftp_source",
        detail: `FTP source present but invalid: ${value}`,
      });
    }
  }

  return { failures, warnings: [] };
}
