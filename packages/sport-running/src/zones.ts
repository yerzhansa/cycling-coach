// ============================================================================
// RUNNING PACE-ZONE CALCULATOR
// ============================================================================
// Anchored on Critical Speed (CS). Only the LT1 lower boundary (0.823 * CS,
// Hunter 2024 meta-analysis) and the heavy↔severe upper boundary (CS itself,
// Nixon 2021) are literature-grounded; the surrounding band edges are a coaching
// convention. CS and all band speeds are SI metres-per-second — intervals.icu
// stores threshold_pace in m/s and uses pace_units only as a display preference.

export interface RunningZoneDisplay {
  label: string;
  value: string;
  overlaps?: boolean;
}

/**
 * LT1 / moderate↔heavy boundary as a fraction of CS (Hunter 2024, 95% CI
 * 81.1–83.6). Ships flat for every athlete; a manual override may move it within
 * LOWER_FRACTION_CLAMP, but no algorithmic fitness-graded factor is applied.
 */
export const LT1_FRACTION_OF_CS = 0.823;

/**
 * Manual lower-boundary override clamp: 0.78 sits just below a low-CS /
 * recreational LT1; 0.88 is the well-trained ceiling and stops the override
 * creeping into the MLSS/LT2 neighbourhood (where a "0.90 easy" mislabels a
 * near-threshold intensity — the grey-zone creep the model rejects).
 */
export const LOWER_FRACTION_CLAMP = { min: 0.78, max: 0.88 } as const;

/**
 * Hard-refusal CS band in m/s: a value outside is unit-confused or corrupt, not a
 * real CS. The typical recreational-to-trained range (~2.5–6.0 m/s, ≈6:40–2:47/km)
 * sits inside; the [2.0, 6.5] edges add headroom before refusing. Kept in sync
 * with the core CS-source gate.
 */
export const CS_SANITY_MPS = { min: 2.0, max: 6.5 } as const;

/** One-sentence disclosure of the threshold definitions the table assumes. */
export const THRESHOLD_DEFINITION =
  "Zones are anchored on Critical Speed: the easy↔moderate boundary is set at " +
  "82.3% of CS (the aerobic-threshold / LT1 line) and the upper sustainable " +
  "boundary is CS itself (the heavy↔severe / maximal-metabolic-steady-state line).";

interface ZoneBand {
  label: string;
  /** Fraction-of-CS at the slow edge; null = open-ended below (slowest). */
  lower: number | null;
  /** Fraction-of-CS at the fast edge; null = open-ended above (fastest). */
  upper: number | null;
}

/**
 * Per-band edges as fractions of CS. The `lowerFraction` edge (Z2 upper / Z3
 * lower) is the overridable LT1 boundary; 1.0 (Z4 upper / Z5 lower) is CS. The
 * override clamp [0.78, 0.88] sits inside (0.72, 0.91), so band ordering relative
 * to Z1's upper (0.72) and Z4's lower (0.91) always holds.
 */
function bands(lowerFraction: number): readonly ZoneBand[] {
  return [
    { label: "Z1 Recovery", lower: null, upper: 0.72 },
    { label: "Z2 Easy", lower: 0.72, upper: lowerFraction },
    { label: "Z3 Moderate", lower: lowerFraction, upper: 0.91 },
    { label: "Z4 Threshold", lower: 0.91, upper: 1.0 },
    { label: "Z5 VO2max", lower: 1.0, upper: 1.12 },
    { label: "Z6 Anaerobic", lower: 1.12, upper: null },
  ];
}

/** Default-fraction band edges, exported for reference + boundary assertions. */
export const ZONE_FRACTIONS: readonly ZoneBand[] = bands(LT1_FRACTION_OF_CS);

function unitFor(paceUnits: string | null | undefined): { meters: number; suffix: string } {
  // MINS_MILE → min/mi; everything else (MINS_KM, SECS_*, NONE, absent) → min/km.
  if (paceUnits === "MINS_MILE") return { meters: 1609.344, suffix: "/mi" };
  return { meters: 1000, suffix: "/km" };
}

/** A speed in m/s rendered as an "M:SS" pace over `meters` (rounded to the second). */
function paceMMSS(speedMps: number, meters: number): string {
  const totalSec = Math.round(meters / speedMps);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Six CS-anchored pace zones. `lowerFraction` defaults to the flat LT1 fraction;
 * a clamped manual override is threaded through here (clamping/disclosure happen
 * in the tool). Output is ordered slowest→fastest (easy→hard); because pace
 * falls as speed rises, Z1 shows the SLOWEST pace ("> X") and Z6 the FASTEST
 * ("< X"), and a band range reads slow→fast (higher pace number first).
 */
export function calculateRunningZones(
  criticalSpeedMps: number,
  paceUnits?: string | null,
  lowerFraction: number = LT1_FRACTION_OF_CS,
): RunningZoneDisplay[] {
  const { meters, suffix } = unitFor(paceUnits);
  const pace = (fraction: number): string => paceMMSS(fraction * criticalSpeedMps, meters);

  return bands(lowerFraction).map(({ label, lower, upper }) => {
    let value: string;
    if (lower === null && upper !== null) {
      value = `> ${pace(upper)}${suffix}`;
    } else if (upper === null && lower !== null) {
      value = `< ${pace(lower)}${suffix}`;
    } else {
      value = `${pace(lower as number)}-${pace(upper as number)}${suffix}`;
    }
    return { label, value };
  });
}

export const ZONE_DESCRIPTIONS: Record<string, string> = {
  "Z1 Recovery":
    "Active-recovery jog; clears fatigue without meaningful aerobic stimulus (RPE 1–2, all-day easy).",
  "Z2 Easy":
    "Aerobic-base bulk of the week, below the aerobic threshold (RPE 3–4, full-sentence conversation).",
  "Z3 Moderate":
    "Steady heavy-domain running from the aerobic threshold upward — the grey zone to spend deliberately (RPE 5–6).",
  "Z4 Threshold":
    "Tempo-to-threshold approaching the sustainable ceiling at CS (RPE 7–8, comfortably hard).",
  "Z5 VO2max":
    "Above CS, no metabolic steady state; 3–8 min VO2 intervals (RPE 9, no talking).",
  "Z6 Anaerobic":
    "Short speed reps driven by anaerobic capacity; duration-limited, not CS-prescribed (RPE 10).",
};

/**
 * Zone-number → representative fraction-of-CS midpoint (open-ended Z1/Z6 use an
 * interior point). Parallels cycling's ZONE_INTENSITY_MIDPOINTS; assumes the flat
 * 0.823 LT1 edge.
 */
export const ZONE_INTENSITY_MIDPOINTS: Record<number, number> = {
  1: 0.66,
  2: 0.77,
  3: 0.87,
  4: 0.955,
  5: 1.06,
  6: 1.2,
};
