/**
 * Resolve the running critical-speed (CS) anchor from synced reference data so
 * the `calculate_zones` tool no longer depends on the LLM supplying it. The
 * resolver and the step-5 CS-source sync gate share ONE row-walk
 * (`collectRunCsRows`) so what gets validated at sync and what gets read back at
 * a turn cannot drift. Manual `critical_speed` outranks platform `threshold_pace`;
 * both are SI metres-per-second. Compute-our-own (best-efforts CS fit) is
 * deferred — this reads only the two locked sources off the raw `sportSettings`.
 */
import type { LatestJson } from "./schemas/latest.js";

// intervals.icu running-family activity types. Kept to the set the running sport
// declares (Run, TrailRun); VirtualRun is intentionally excluded — not in core's
// IntervalsActivityType union this wave. Shared by the resolver and the step-5
// gate (validation/checks/step5-cs-source.ts) so the two cannot diverge.
export const RUN_FAMILY_TYPES = new Set<string>(["Run", "TrailRun"]);

// Hard-refusal CS band in m/s: a value outside is unit-confused or corrupt, not a
// real CS. Typical recreational-to-trained range (~2.5–6.0 m/s, ≈6:40–2:47/km)
// sits inside; [2.0, 6.5] adds headroom before refusing. Single source of truth:
// sport-running derives its CS_SANITY_MPS from these via the core barrel re-export
// (compiler-enforced), so the two bands cannot drift.
export const CS_MIN_MPS = 2.0;
export const CS_MAX_MPS = 6.5;

export type CsConfidence = "high" | "medium" | "low";

/** One run-family `sportSettings` row's CS-relevant fields. */
export interface RunCsRow {
  /** Manual override (`critical_speed`), m/s. Outranks `thresholdPace`. */
  criticalSpeed: number | null;
  /** Platform-supplied anchor (`threshold_pace`), m/s. */
  thresholdPace: number | null;
  /** Platform reliability label (`cs_confidence`); disclosure-only. */
  confidence: CsConfidence | null;
}

/** The resolved primary anchor handed to the running zone tool per turn. */
export interface ResolvedCs {
  criticalSpeedMps: number;
  source: "platform" | "athlete_manual";
  confidence: CsConfidence | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function asConfidence(value: unknown): CsConfidence | null {
  return value === "high" || value === "medium" || value === "low" ? value : null;
}

/**
 * Walk an athlete profile's `sportSettings` for run-family rows and return their
 * CS-relevant fields. Operates on the raw profile object (`athlete_profile` is
 * `unknown` on `LatestJson`, and `FetchedReference.latest.athlete_profile` is the
 * same shape), narrowing defensively. Returns `[]` when no profile / no run row
 * is present (RESOLVE-OR-SKIP — a cyclist with no Run activity is not an error).
 */
export function collectRunCsRows(athleteProfile: unknown): RunCsRow[] {
  const profile = asRecord(athleteProfile);
  if (profile === null) return [];

  const sportSettings = profile.sportSettings;
  if (!Array.isArray(sportSettings)) return [];

  return sportSettings.flatMap((row) => {
    const r = asRecord(row);
    if (r === null) return [];
    const types = r.types;
    if (!Array.isArray(types)) return [];
    const isRun = types.some((t) => typeof t === "string" && RUN_FAMILY_TYPES.has(t));
    if (!isRun) return [];
    return [
      {
        criticalSpeed: typeof r.critical_speed === "number" ? r.critical_speed : null,
        thresholdPace: typeof r.threshold_pace === "number" ? r.threshold_pace : null,
        confidence: asConfidence(r.cs_confidence),
      },
    ];
  });
}

function inBand(value: number): boolean {
  return Number.isFinite(value) && value >= CS_MIN_MPS && value <= CS_MAX_MPS;
}

/**
 * Resolve the running CS anchor from `latest.json`. Manual `critical_speed`
 * outranks platform `threshold_pace` (mirrors the step-5 gate's precedence). Each
 * value is band-checked defensively (the gate refuses out-of-band CS at sync, but
 * a manual override could in principle reach `latest.json` un-gated) — an
 * out-of-band value is skipped, never returned. Returns `null` when no in-band
 * anchor is present, so a pre-sync or non-running athlete falls back to the tool's
 * LLM-supplied param rather than minting a corrupt zone table.
 */
export function resolveRunningCs(latest: LatestJson | null): ResolvedCs | null {
  const rows = collectRunCsRows(latest?.athlete_profile);

  for (const row of rows) {
    if (row.criticalSpeed !== null && inBand(row.criticalSpeed)) {
      return { criticalSpeedMps: row.criticalSpeed, source: "athlete_manual", confidence: row.confidence };
    }
  }
  for (const row of rows) {
    if (row.thresholdPace !== null && inBand(row.thresholdPace)) {
      return { criticalSpeedMps: row.thresholdPace, source: "platform", confidence: row.confidence };
    }
  }
  return null;
}
