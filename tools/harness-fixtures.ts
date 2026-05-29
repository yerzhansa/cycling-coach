/**
 * The golden-fixture allowlist the snapshot harness processes, each with its
 * frozen-now anchor. Single source of truth shared by the snapshot harness
 * (tools/snapshot-section-11.ts) and the coverage probe
 * (tools/measure-reference-coverage.ts), so the per-fixture anchors can't
 * drift between the two.
 *
 * Adding a fixture is an explicit edit here — the golden dir also holds
 * fixtures owned by other tests (the F7 reference substrate's
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
    frozenNow: DEFAULT_FROZEN_NOW,
    description:
      "Happy-path baseline — sanitized real athlete bundle. Exercises the populated branches of every metric. Anchor 2026-05-10 sits one day after the fixture's last activity.",
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
      "Populated-branch coverage for consistency_index + benchmark_indoor + benchmark_outdoor — the F11 metrics whose previous fixtures all collapsed to the null branch. 4 WORKOUT events on 05-05/07/09/10 paired with cycling activities on 05-05/07/09 give matched=3, planned=4, consistency_index=0.75. FTP history has a 2026-03-15 entry sitting exactly at (frozenNow - 56d), exercising the +/-7d nearest-match window: indoor 280/270-1=0.037 in seasonal range [0.01,0.04] → seasonal_expected=true; outdoor 270/260-1=0.038 same range true. Without this fixture the parity gate is theatre for those three metrics.",
  },
  {
    slug: "rest-week-with-baseline",
    frozenNow: DEFAULT_FROZEN_NOW,
    description:
      "Constant-Load coverage for the monotony stdev=0 branch. 7 recovery rides on 05-04..05-10 at an IDENTICAL daily Load of 35.0 give the 7d series [35,35,35,35,35,35,35] — non-zero mean, sample stdev exactly 0 — so monotony hits the `stdevLoad <= 0 -> null` guard (a path the all-zero fixtures reach via a different branch). That null cascades: strain -> null, stress_tolerance -> null. Single-sport, so primary_sport_monotony hits its own stdev=0 null too. The 28-day wellness baseline (stable RHR 58 / HRV 52) populates recovery_index + HRV/RHR baselines through the flat block. Anchor 2026-05-10 puts the constant week in the 7d acute window.",
  },
];
