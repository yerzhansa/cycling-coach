// Reference layer per-second dfa_a1 stream input (buildDfaBlock). The dfa_a1
// channel is consumed directly as a per-second AlphaHRV series — it is NOT
// derived from R-R intervals — so these helpers synthesize the four index-aligned
// per-second channels (dfa_a1 / artifacts / heartrate / watts) the curator joins
// back to an activity by String(activity.id).
//
// Determinism: every value is a closed-form binary-fraction center or an
// LCG-driven integer; there is no wall-clock read and no runtime RNG, so a
// re-run produces byte-identical channels.

/** Below this dfa_a1 value a second is dropped (AlphaHRV sentinel floor). */
export const DFA_MIN_VALID_VALUE = 0.01;
/** Above this artifact percentage a second is dropped (noise rejection). */
export const DFA_ARTIFACT_MAX_PCT = 5.0;
/** Shipped 20-minute valid-duration gate. */
export const DFA_MIN_DURATION_SECS = 1200;
/** Shipped valid-percentage gate. */
export const DFA_SUFFICIENT_MIN_VALID_PCT = 70.0;

// Exact binary fractions so the rollup carries no float drift across runtimes.
const DFA_Z2_CENTER = 0.75; // a clean aerobic-endurance α1 center, comfortably ≥ floor
const HR_Z2 = 142;
const WATTS_Z2 = 205;

export interface StreamChannels {
  dfa_a1: number[];
  artifacts: number[];
  heartrate: (number | null)[];
  watts: (number | null)[];
}

interface Segment {
  dfa: number;
  hr: number;
  watts: number;
  secs: number;
}

/** Build the four index-aligned channels from explicit per-second segments. */
function buildDfaStream(segments: readonly Segment[]): StreamChannels {
  const dfa_a1: number[] = [];
  const artifacts: number[] = [];
  const heartrate: (number | null)[] = [];
  const watts: (number | null)[] = [];
  for (const seg of segments) {
    for (let s = 0; s < seg.secs; s++) {
      dfa_a1.push(seg.dfa);
      artifacts.push(0.0);
      heartrate.push(seg.hr);
      watts.push(seg.watts);
    }
  }
  return { dfa_a1, artifacts, heartrate, watts };
}

/** A clean all-valid aerobic session of the given duration. */
export function buildCleanStream(secs: number): StreamChannels {
  return buildDfaStream([{ dfa: DFA_Z2_CENTER, hr: HR_Z2, watts: WATTS_Z2, secs }]);
}

// Deterministic integer LCG (the classic Numerical-Recipes constants). Seeded,
// so noise placement is reproducible and never touches Math.random.
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state;
  };
}

/**
 * Push roughly `targetInvalidFraction` of the seconds above the artifact ceiling
 * so they drop out of the valid set, driving validPct down by a clear margin.
 * The placement is LCG-driven and therefore deterministic for a given seed.
 */
export function degradeBelowValidPct(
  ch: StreamChannels,
  seed: number,
  targetInvalidFraction: number,
): StreamChannels {
  const next = lcg(seed);
  const n = ch.dfa_a1.length;
  const artifacts = ch.artifacts.slice();
  for (let i = 0; i < n; i++) {
    // Map the LCG output into [0, 1) and corrupt the second when it lands in the
    // target band. A fixed artifact value well above the ceiling guarantees the
    // gate drops the second regardless of rounding.
    const r = next() / 0x100000000;
    if (r < targetInvalidFraction) {
      artifacts[i] = DFA_ARTIFACT_MAX_PCT + 5.0;
    }
  }
  return { ...ch, artifacts };
}

/**
 * Recompute the gate independently from the documented thresholds. Used by the
 * builder's non-vacuity guard and re-asserted in the fixture test — a fixture
 * that is parity-green but vacuous (e.g. clean stream that does not actually
 * clear the gate) fails here before it can ship. Uses raw-float validPct; author
 * fixtures OFF the 70% boundary so this never disagrees with the rounded gate.
 */
export function recomputeSufficiency(ch: StreamChannels): {
  validSecs: number;
  validPct: number;
  sufficient: boolean;
} {
  const n = ch.dfa_a1.length;
  let validSecs = 0;
  for (let i = 0; i < n; i++) {
    const d = ch.dfa_a1[i];
    const a = ch.artifacts[i];
    if (d == null || d < DFA_MIN_VALID_VALUE) continue;
    if (a != null && a > DFA_ARTIFACT_MAX_PCT) continue;
    validSecs++;
  }
  const validPct = n ? (100.0 * validSecs) / n : 0.0;
  const sufficient =
    validSecs >= DFA_MIN_DURATION_SECS && validPct >= DFA_SUFFICIENT_MIN_VALID_PCT;
  return { validSecs, validPct, sufficient };
}
