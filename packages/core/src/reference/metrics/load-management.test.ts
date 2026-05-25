import { describe, expect, it } from "vitest";

import {
  computeEffectiveMonotony,
  computeLoadRecoveryRatio,
  computeMonotony,
  computeMonotonyInterpretation,
  computeRecoveryIndex,
  computeStrain,
  computeStressTolerance,
} from "./load-management.js";
import type { MetricInput } from "./metric-input.js";

// These computers read only start_date_local, icu_training_load, and (for
// the per-sport split) type through the shared daily-Load aggregators; the
// full Activity shape is exercised by the parity matrix against golden
// fixtures. These synthetic rows isolate the formulae. `fixture` is typed
// `unknown` at the gate boundary, so minimal rows ride through untyped.
function input(
  activities: {
    start_date_local: string;
    icu_training_load: number;
    type?: string;
  }[],
  frozenNow: string,
): MetricInput {
  return { fixture: { activities }, frozenNow };
}

describe("computeStrain", () => {
  const FROZEN = "2026-05-10T12:00:00";

  it("returns weekly Load × monotony, rounded half-to-even", () => {
    // 7-day window 05-04..05-10. Loads 50 (05-06) + 50 (05-08) + 100
    // (05-10) ⇒ weekly Load 200, monotony 0.73 ⇒ round(200 × 0.73) = 146.
    const result = computeStrain(
      input(
        [
          { start_date_local: "2026-05-06T08:00:00", icu_training_load: 50 },
          { start_date_local: "2026-05-08T08:00:00", icu_training_load: 50 },
          { start_date_local: "2026-05-10T08:00:00", icu_training_load: 100 },
        ],
        FROZEN,
      ),
    );
    expect(result).toBe(146);
  });

  it("cascades Unknown: monotony null ⇒ strain null", () => {
    // No activity in the window ⇒ every daily Load is 0 ⇒ monotony null.
    expect(computeStrain(input([], FROZEN))).toBeNull();
  });
});

describe("computeStressTolerance", () => {
  const FROZEN = "2026-05-10T12:00:00";

  it("returns (strain / monotony) / 100, rounded half-to-even", () => {
    // Same window as the strain test: loads 50/50/100 ⇒ weekly Load 200,
    // monotony 0.73, strain round(200 × 0.73) = 146. Stress tolerance is
    // (146 / 0.73) / 100 = 200 / 100 = round(2.0, 1) = 2.
    const result = computeStressTolerance(
      input(
        [
          { start_date_local: "2026-05-06T08:00:00", icu_training_load: 50 },
          { start_date_local: "2026-05-08T08:00:00", icu_training_load: 50 },
          { start_date_local: "2026-05-10T08:00:00", icu_training_load: 100 },
        ],
        FROZEN,
      ),
    );
    expect(result).toBe(2);
  });

  it("cascades Unknown: monotony null ⇒ strain null ⇒ stress tolerance null", () => {
    // No activity in the window ⇒ monotony null ⇒ strain null ⇒ null.
    expect(computeStressTolerance(input([], FROZEN))).toBeNull();
  });
});

describe("computeMonotonyInterpretation", () => {
  const FROZEN = "2026-05-10T12:00:00";

  it("cascades Unknown: effective monotony null ⇒ interpretation null", () => {
    // No activity in the window ⇒ monotony null ⇒ effective null ⇒ Unknown.
    expect(computeMonotonyInterpretation(input([], FROZEN))).toBeNull();
  });

  it('returns the bare "normal" band when effective monotony ≤ 2.0', () => {
    // Single sport family, low monotony (0.73) ⇒ no multi-sport annotation.
    const result = computeMonotonyInterpretation(
      input(
        [
          { start_date_local: "2026-05-06T08:00:00", icu_training_load: 50 },
          { start_date_local: "2026-05-08T08:00:00", icu_training_load: 50 },
          { start_date_local: "2026-05-10T08:00:00", icu_training_load: 100 },
        ],
        FROZEN,
      ),
    );
    expect(result).toBe("normal");
  });

  it('returns the bare "elevated" band when effective monotony > 2.0', () => {
    // Single sport family, near-flat Load across all 7 days ⇒ high monotony.
    const result = computeMonotonyInterpretation(
      input(
        [
          { start_date_local: "2026-05-04T08:00:00", icu_training_load: 100 },
          { start_date_local: "2026-05-05T08:00:00", icu_training_load: 100 },
          { start_date_local: "2026-05-06T08:00:00", icu_training_load: 100 },
          { start_date_local: "2026-05-07T08:00:00", icu_training_load: 100 },
          { start_date_local: "2026-05-08T08:00:00", icu_training_load: 100 },
          { start_date_local: "2026-05-09T08:00:00", icu_training_load: 100 },
          { start_date_local: "2026-05-10T08:00:00", icu_training_load: 95 },
        ],
        FROZEN,
      ),
    );
    expect(result).toBe("elevated");
  });

  it("annotates the multi-sport-inflation band with both monotony values", () => {
    // A varied Ride series (primary) plus a consistent Run floor on the
    // otherwise-empty days: the floor inflates total monotony above the
    // primary-sport value, so effective (= primary) < total triggers the
    // annotated branch. The exact values are composed from the sibling
    // computers; bit-identity against the upstream is the parity matrix's
    // job (realistic-athlete covers this branch).
    const multi = input(
      [
        { start_date_local: "2026-05-06T08:00:00", icu_training_load: 50, type: "Ride" },
        { start_date_local: "2026-05-08T08:00:00", icu_training_load: 100, type: "Ride" },
        { start_date_local: "2026-05-09T08:00:00", icu_training_load: 50, type: "Ride" },
        { start_date_local: "2026-05-10T08:00:00", icu_training_load: 100, type: "Ride" },
        { start_date_local: "2026-05-04T08:00:00", icu_training_load: 30, type: "Run" },
        { start_date_local: "2026-05-05T08:00:00", icu_training_load: 30, type: "Run" },
        { start_date_local: "2026-05-07T08:00:00", icu_training_load: 30, type: "Run" },
      ],
      FROZEN,
    );
    const out = computeMonotonyInterpretation(multi);
    expect(out).toMatch(
      /^normal \(primary sport .+, total .+ inflated by multi-sport\)$/,
    );
    expect(out).toContain(`primary sport ${computeEffectiveMonotony(multi)}`);
    expect(out).toContain(`total ${computeMonotony(multi)}`);
  });
});

// computeRecoveryIndex reads only id, hrv, and restingHR from the
// trailing 7-day wellness window; bit-identity against the upstream on
// the populated path is the parity matrix's job (realistic-athlete = 0.91,
// data-gap-mid-history = 1). These rows isolate the ratio formula and the
// edge cases the three fixtures don't separate.
function wellnessInput(
  wellness: { id: string; hrv: number | null; restingHR: number | null }[],
  frozenNow: string,
): MetricInput {
  return { fixture: { wellness }, frozenNow };
}

describe("computeRecoveryIndex", () => {
  const FROZEN = "2026-05-10T12:00:00";

  it("returns (latestHrv/hrvBaseline) ÷ (latestRhr/rhrBaseline), rounded half-to-even", () => {
    // Window 05-04..05-10. HRV baseline mean(40,50)=45, RHR baseline 60,
    // latest (05-10) HRV 50 / RHR 60 ⇒ (50/45)/(60/60) ⇒ round(1.111…)=1.11.
    const result = computeRecoveryIndex(
      wellnessInput(
        [
          { id: "2026-05-09", hrv: 40, restingHR: 60 },
          { id: "2026-05-10", hrv: 50, restingHR: 60 },
        ],
        FROZEN,
      ),
    );
    expect(result).toBe(1.11);
  });

  it("returns Unknown (null) when there is no wellness data", () => {
    expect(computeRecoveryIndex(wellnessInput([], FROZEN))).toBeNull();
  });

  it("returns Unknown (null) when the latest HRV reading is out of band", () => {
    // 5ms RMSSD is below the 10-250 validity band ⇒ latest HRV rejected ⇒
    // the ratio guard fails even though a baseline exists from prior days.
    const result = computeRecoveryIndex(
      wellnessInput(
        [
          { id: "2026-05-09", hrv: 45, restingHR: 60 },
          { id: "2026-05-10", hrv: 5, restingHR: 60 },
        ],
        FROZEN,
      ),
    );
    expect(result).toBeNull();
  });

  it("reads the LAST in-window row as latest, in fixture order — not the chronologically latest", () => {
    // Rows supplied with the earlier date last. The upstream takes
    // wellness_7d[-1] (last array element), so latest = the 05-08 row
    // (HRV 40), not the 05-10 row. Baseline mean(50,40)=45 ⇒
    // (40/45)/(60/60) ⇒ round(0.888…)=0.89. Chronological-latest would
    // give 1.11.
    const result = computeRecoveryIndex(
      wellnessInput(
        [
          { id: "2026-05-10", hrv: 50, restingHR: 60 },
          { id: "2026-05-08", hrv: 40, restingHR: 60 },
        ],
        FROZEN,
      ),
    );
    expect(result).toBe(0.89);
  });
});

// computeLoadRecoveryRatio reads activities (for weekly Load) and the
// trailing 7-day wellness window (for the recovery index). These rows
// isolate the ratio formula and the recovery-index cascade; bit-identity
// on the populated path is the parity matrix's job (realistic-athlete =
// 2.8, data-gap-mid-history = 3.6).
function loadRecoveryInput(
  activities: { start_date_local: string; icu_training_load: number }[],
  wellness: { id: string; hrv: number | null; restingHR: number | null }[],
  frozenNow: string,
): MetricInput {
  return { fixture: { activities, wellness }, frozenNow };
}

describe("computeLoadRecoveryRatio", () => {
  const FROZEN = "2026-05-10T12:00:00";

  it("returns weeklyLoad / (recoveryIndex × 100), rounded half-to-even", () => {
    // Window 05-04..05-10. Loads 50/50/100 ⇒ weekly Load 200. Wellness
    // baseline mean(40,50)=45, latest (05-10) HRV 50 / RHR 60 ⇒ ri 1.11.
    // 200 / (1.11 × 100) = 200 / 111 ⇒ round(1.801…, 1) = 1.8.
    const result = computeLoadRecoveryRatio(
      loadRecoveryInput(
        [
          { start_date_local: "2026-05-06T08:00:00", icu_training_load: 50 },
          { start_date_local: "2026-05-08T08:00:00", icu_training_load: 50 },
          { start_date_local: "2026-05-10T08:00:00", icu_training_load: 100 },
        ],
        [
          { id: "2026-05-09", hrv: 40, restingHR: 60 },
          { id: "2026-05-10", hrv: 50, restingHR: 60 },
        ],
        FROZEN,
      ),
    );
    expect(result).toBe(1.8);
  });

  it("cascades Unknown: recovery index null ⇒ load-recovery ratio null", () => {
    // Activities present, but no wellness ⇒ recovery index null ⇒ the
    // `ri and ri > 0` guard fails ⇒ null, even with weekly Load > 0.
    const result = computeLoadRecoveryRatio(
      loadRecoveryInput(
        [{ start_date_local: "2026-05-10T08:00:00", icu_training_load: 100 }],
        [],
        FROZEN,
      ),
    );
    expect(result).toBeNull();
  });
});
