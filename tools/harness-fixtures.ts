/**
 * The golden-fixture allowlist the snapshot harness processes, each with its
 * frozen-now anchor. Single source of truth shared by the snapshot harness
 * (tools/snapshot-section-11.ts) and the coverage probe
 * (tools/measure-reference-coverage.ts), so the per-fixture anchors can't
 * drift between the two.
 *
 * Adding a fixture is an explicit edit here — the golden dir also holds
 * fixtures owned by other tests (the reference test substrate's
 * `post-break-resume`, `zero-activities`) that don't conform to sync.py's
 * contract and must not be run through the harness. Each entry's `description`
 * carries the rationale for the slug + the anchor it chose.
 */

// Default anchor. The manifest's `frozen_now` field also takes this value as
// the default; per-fixture overrides ride through each per-snapshot wrapper's
// `frozen_now` field.
export const DEFAULT_FROZEN_NOW = "2026-05-10T12:00:00";

export interface HarnessFixtureConfig {
  slug: string;
  frozenNow: string;
  description: string;
}

export const HARNESS_FIXTURES: HarnessFixtureConfig[] = [
  {
    slug: "realistic-athlete",
    // Own explicit anchor (NOT DEFAULT_FROZEN_NOW): this fixture's dates were
    // shifted back one full Gregorian cycle to de-identify the real athlete's
    // training calendar, so its anchor must shift in lockstep. Out-of-scope
    // fixtures still share DEFAULT_FROZEN_NOW and must not move.
    frozenNow: "1998-05-10T12:00:00",
    description:
      "Happy-path baseline — sanitized real athlete bundle. Exercises the populated branches of every metric. Anchor 1998-05-10 sits one day after the fixture's last activity.",
  },
  {
    slug: "new-athlete-empty",
    frozenNow: DEFAULT_FROZEN_NOW,
    description:
      "Zero activities, zero wellness, zero ftp_history. Forces every 'no data' branch — ACWR div-by-zero, monotony of empty week, recovery_index no-contributors. Anchor doesn't matter; reuses the default.",
  },
  {
    slug: "data-gap-mid-history",
    frozenNow: "2026-05-20T12:00:00",
    description:
      "21 activities split by a 28-day gap (14 days 2026-04-01..04-14, gap 04-15..05-12, 7 days resumed 05-13..05-19). Exercises EWMA decay through the gap, ACWR chronic window seeing zeros, monotony on the resumed week. Anchor 2026-05-20 catches the resumed week in the 7d acute window.",
  },
  {
    slug: "boundary-monotony",
    frozenNow: DEFAULT_FROZEN_NOW,
    description:
      "Boundary-seeking fixture (fuzz-derived). Daily loads [21.2,154.3,268.1,122.0,34.6,33.1,231.2] over 05-04..05-10 put monotony's mean/stdev ratio exactly on the 2-dp boundary: the correctly-rounded statistics path gives 1.24, a naive float stdev gives 1.23. Defends the exact-rational mean/stdev port at the gate. Load-only (no wellness/ftp).",
  },
  {
    slug: "boundary-sum-strain",
    frozenNow: DEFAULT_FROZEN_NOW,
    description:
      "Boundary-seeking fixture (fuzz-derived). Daily loads 9.7/266.4/239.5/9.4 over 05-06..05-09 sum to exactly 525.0 under compensated (Neumaier) summation but 524.999…9 naively; with monotony 0.62 the product 325.5 rounds to strain 326 where a naive sum gives 325. Defends the compensated-sum port at the gate. Load-only (no wellness/ftp).",
  },
  {
    slug: "boundary-zone-total-secs",
    frozenNow: DEFAULT_FROZEN_NOW,
    description:
      "Boundary-seeking fixture (fuzz-derived). Three activities (05-08..05-10) whose z1–z7 one-decimal-second bins sum, per-activity-compensated, to exactly 36594s, but accumulate to 36594.00000000001s under a single flat naive sum across every activity's bins; that 1-ULP drift pushes total_hours across the 10.165 boundary (compensated 10.16 vs naive 10.17). Defends the per-activity compensated zone-total summation in the zone-distribution port. Zone-only (empty wellness/ftp).",
  },
  {
    slug: "multisport-tie",
    frozenNow: DEFAULT_FROZEN_NOW,
    description:
      "Primary-sport tiebreak fixture. Cycling [100,80,60] on 05-04..06 and run [60,60,60,60] on 05-07..10 each total exactly 240 over the 7d window; cycling is encountered first, so the `total > maxTotal` strict tiebreak (mirroring Python `max(dict, key=dict.get)` insertion order) must pick cycling. The two sports' daily distributions differ, so a tiebreak regression flips primary_sport_monotony to run's value — caught at the gate. Load+zones only (empty wellness/ftp).",
  },
  {
    slug: "multisport-thin-primary",
    frozenNow: DEFAULT_FROZEN_NOW,
    description:
      "effective_monotony selector branch B (multi-sport, primary=null → fall back to total). Cycling [80,80,80] on 05-04..06 (total 240, 3 days) and run [150,150] on 05-09..10 (total 300, 2 days): run wins primary on total but has <3 active days, so primary_sport_monotony is null while total monotony is non-null. The selector's `!== null` gate does load-bearing work here — inverting it regresses with no other fixture defense. Load+zones only (empty wellness/ftp).",
  },
  {
    slug: "populated-benchmark-and-consistency",
    frozenNow: DEFAULT_FROZEN_NOW,
    description:
      "Populated-branch coverage for consistency_index + benchmark_indoor + benchmark_outdoor — metrics whose previous fixtures all collapsed to the null branch. 4 WORKOUT events on 05-05/07/09/10 paired with cycling activities on 05-05/07/09 give matched=3, planned=4, consistency_index=0.75. FTP history has a 2026-03-15 entry sitting exactly at (frozenNow - 56d), exercising the +/-7d nearest-match window: indoor 280/270-1=0.037 in seasonal range [0.01,0.04] → seasonal_expected=true; outdoor 270/260-1=0.038 same range true. Without this fixture the parity gate is theatre for those three metrics.",
  },
  {
    slug: "rest-week-with-baseline",
    frozenNow: DEFAULT_FROZEN_NOW,
    description:
      "Constant-Load coverage for the monotony stdev=0 branch. 7 recovery rides on 05-04..05-10 at an IDENTICAL daily Load of 35.0 give the 7d series [35,35,35,35,35,35,35] — non-zero mean, sample stdev exactly 0 — so monotony hits the `stdevLoad <= 0 -> null` guard (a path the all-zero fixtures reach via a different branch). That null cascades: strain -> null, stress_tolerance -> null. Single-sport, so primary_sport_monotony hits its own stdev=0 null too. The 28-day wellness baseline (stable RHR 58 / HRV 52) populates recovery_index + HRV/RHR baselines through the flat block. Anchor 2026-05-10 puts the constant week in the 7d acute window.",
  },
  {
    slug: "capability-qualifying",
    // Own explicit anchor (NOT DEFAULT_FROZEN_NOW): derived from the
    // realistic-athlete base, its dates were shifted back one full Gregorian
    // cycle for de-identification, so its anchor moves with them.
    frozenNow: "1998-05-10T12:00:00",
    description:
      "Populated-branch coverage for the capability sub-keys (durability, efficiency_factor, hrrc). Appends 5 steady-state qualifying Rides (VI 1.0, moving_time 6000s, decoupling/EF/hrr present) to the realistic-athlete base — 3 in the 7d window, 5 in the 28d window — clearing durability's reliability gate (N7>=3, N28>=5) and exercising the means + trends the all-null fixtures never reach. Built by tools/build-capability-fixture.ts (qualifying Rides appended to the tail AFTER the sanitizer over the realistic-athlete base — they carry the raw icu_hr_decoupling/bare-icu_hrr API surface and de-identified synthetic ids, so they bypass the base's sanitizer walk; the builder's non-vacuity guard recomputes the reliability gate).",
  },
  {
    slug: "curve-equipped",
    frozenNow: "1998-06-04T12:00:00",
    description:
      "Populated-branch coverage for the curve/power-model capability keys (power_curve_delta, hr_curve_delta, sustainability_profile) + the 6 power-model scalars (eftp, w_prime, w_prime_kj, p_max, power_model_source, vo2max). Hybrid: real sanitized activity/wellness rows plus synthetic power_curves/hr_curves (both 28d delta windows at all rotation anchors), sustainability_curves (single 42d window, cycling Ride+VirtualRide), athlete.sportSettings (ftp 200 / indoor 195 / lthr 168), and a latest-row Ride sportInfo carrying eftp/wPrime/pMax + vo2max. Anchor 1998-06-04 places win1 (now-27..today) and win2 (now-55..now-28) over distinct real-data windows, so every pct_change and rotation_index is non-null. Built by tools/build-curve-fixture.ts (curve blocks attached AFTER the sanitizer — they bypass the default-deny key filter and the id redaction that would clobber the r.<start>.<end> curve ids).",
  },
  {
    slug: "dfa-equipped",
    frozenNow: "2026-06-04T12:00:00",
    description:
      "Populated-branch coverage for capability.dfa_a1_profile. Fully synthetic (no sanitizer, no real data): 7 Ride activities (ids 90201-90207) on 2026-05-28..06-03, each carrying a per-second streams record (dfa_a1/artifacts/heartrate/watts, 1800 samples) keyed by String(id) in the top-level `streams` key. Every session is 3×600s segments at dfa_a1 1.0 / 0.75 / 0.5 with artifacts 0 — so valid_secs=1800, valid_pct=100, and each session holds 600s of dwell in BOTH the LT1 band [0.95,1.05] and the LT2 band [0.45,0.55] with co-present heartrate+watts. The 7 qualifying sessions push crossing_n to 7 (>=6), so the cycling trailing window reports confidence=high with non-null lt1_estimate + lt2_estimate. Built by tools/build-dfa-fixture.ts (synthetic stream blob + non-vacuity guard recomputing the sufficiency + crossing-band thresholds). Anchor 2026-06-04 sits one day after the last ride.",
  },
  {
    slug: "running-only",
    frozenNow: "1998-06-04T12:00:00",
    description:
      "Pure-pace coverage, fully-synthetic Run/TrailRun bundle (ids 90301+) with non-zero load + realistic low-intensity-dominant zone-time data so run Load flows through ACWR/monotony/strain AND the Seiler-TID/zone-distribution survivors compute non-degenerately; carries NO watts/power fields; built by tools/build-running-fixture.ts, synthetic, ids 90301+.",
  },
];

/**
 * Anchor for a slug that may or may not be allowlisted. Single-fixture debug
 * regens (SNAPSHOT_FIXTURE_PATH) must reuse the allowlisted anchor — writing a
 * 1998-anchored fixture's snapshots at the 2026 default would be a wrong-anchor
 * regen the native-check gate cannot catch, because the gate mirrors whatever
 * anchor was written.
 */
export function resolveFixtureAnchor(slug: string): string {
  return (
    HARNESS_FIXTURES.find((f) => f.slug === slug)?.frozenNow ??
    DEFAULT_FROZEN_NOW
  );
}
