import { describe, expect, it } from "vitest";

import {
  computeEffectiveMonotony,
  computeLoadRecoveryRatio,
  computeMonotony,
  computeMonotonyInterpretation,
  computeMultiSportDetected,
  computePrimarySportMonotony,
  computeRecoveryIndex,
  computeStrain,
  computeStressTolerance,
} from "./load-management.js";
import type { MetricInput } from "./metric-input.js";

// The synthetic rows in this file are intentionally minimal — only the fields
// each formula reads — so they don't satisfy the full parsed Activity /
// WellnessDay shape. asFixture casts them through the gate-boundary fixture
// type at one local seam; the full shape is exercised by the parity matrix
// against captured fixtures.
function asFixture(rows: {
  activities?: unknown[];
  wellness?: unknown[];
}): MetricInput["fixture"] {
  return rows as unknown as MetricInput["fixture"];
}

// These computers read only start_date_local, icu_training_load, and (for
// the per-sport split) type through the shared daily-Load aggregators.
function input(
  activities: {
    start_date_local: string;
    icu_training_load: number;
    type?: string;
  }[],
  frozenNow: string,
): MetricInput {
  return { fixture: asFixture({ activities }), frozenNow };
}

describe("computeMonotony", () => {
  const FROZEN = "2026-05-10T12:00:00";

  it("rounds on the exact mean/stdev at a 2-dp boundary, not the float ones", () => {
    // 7-day window 05-04..05-10, one activity per day with loads whose exact
    // mean is 123.5 and exact stdev 100.0 ⇒ ratio exactly 1.235 ⇒ Python
    // round-half-to-even = 1.24. The previous float mean/stdev nudged the
    // ratio just under 1.235 and rounded to 1.23. Monotony is order-
    // independent under exact arithmetic, so the day assignment is arbitrary.
    const loads = [21.2, 154.3, 268.1, 122.0, 34.6, 33.1, 231.2];
    const days = ["04", "05", "06", "07", "08", "09", "10"];
    const result = computeMonotony(
      input(
        loads.map((load, i) => ({
          start_date_local: `2026-05-${days[i]}T08:00:00`,
          icu_training_load: load,
        })),
        FROZEN,
      ),
    );
    expect(result).toBe(1.24);
  });
});

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

  it("sums weekly Load with Neumaier compensation at a round-0 boundary", () => {
    // Daily loads 9.7/266.4/239.5/9.4 sum to exactly 525.0 under the oracle's
    // compensated sum() (3.12+); a naive reduce gives 524.999…9. With monotony
    // 0.62 the product is 325.5 → round-half-even = 326. Naive summation made
    // it 325.499…9 → 325. Pins the pythonSum fix end-to-end.
    const result = computeStrain(
      input(
        [
          { start_date_local: "2026-05-06T08:00:00", icu_training_load: 9.7 },
          { start_date_local: "2026-05-07T08:00:00", icu_training_load: 266.4 },
          { start_date_local: "2026-05-08T08:00:00", icu_training_load: 239.5 },
          { start_date_local: "2026-05-09T08:00:00", icu_training_load: 9.4 },
        ],
        FROZEN,
      ),
    );
    expect(result).toBe(326);
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

describe("computeMultiSportDetected", () => {
  const FROZEN = "2026-05-10T12:00:00";

  it("returns true when the 7-day window spans two sport families", () => {
    const result = computeMultiSportDetected(
      input(
        [
          { start_date_local: "2026-05-09T08:00:00", icu_training_load: 80, type: "Ride" },
          { start_date_local: "2026-05-10T08:00:00", icu_training_load: 40, type: "Run" },
        ],
        FROZEN,
      ),
    );
    expect(result).toBe(true);
  });

  it("returns false when all in-window activity is one sport family", () => {
    const result = computeMultiSportDetected(
      input(
        [
          { start_date_local: "2026-05-08T08:00:00", icu_training_load: 50, type: "Ride" },
          { start_date_local: "2026-05-10T08:00:00", icu_training_load: 100, type: "Ride" },
        ],
        FROZEN,
      ),
    );
    expect(result).toBe(false);
  });

  it("returns false with no activities", () => {
    expect(computeMultiSportDetected(input([], FROZEN))).toBe(false);
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
  return { fixture: asFixture({ wellness }), frozenNow };
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
  return { fixture: asFixture({ activities, wellness }), frozenNow };
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

describe("load aggregators — malformed start_date_local is dropped, not thrown", () => {
  const FROZEN = "2026-05-10T12:00:00";

  // The load aggregators run over raw, unwindowed activities, so a row with a
  // non-string start_date_local reaches the date slice (the distribution path
  // is pre-windowed and never sees one). The oracle's window filter silently
  // drops such rows; we must match — drop the row, compute over the rest —
  // rather than throwing on it.
  const wellFormed = [
    { start_date_local: "2026-05-06T08:00:00", icu_training_load: 50, type: "Ride" },
    { start_date_local: "2026-05-08T08:00:00", icu_training_load: 50, type: "Ride" },
    { start_date_local: "2026-05-10T08:00:00", icu_training_load: 100, type: "Ride" },
  ];

  function fixtureOf(activities: unknown[]): MetricInput {
    return { fixture: asFixture({ activities }), frozenNow: FROZEN };
  }

  it("computeMonotony drops a null-date row (getDailyLoad)", () => {
    const baseline = computeMonotony(fixtureOf(wellFormed));
    expect(baseline).not.toBeNull();

    const nullDate = { start_date_local: null, icu_training_load: 999, type: "Ride" };
    let withMalformed: number | null = null;
    expect(() => {
      withMalformed = computeMonotony(fixtureOf([...wellFormed, nullDate]));
    }).not.toThrow();
    expect(withMalformed).toBe(baseline);
  });

  it("computeEffectiveMonotony drops a missing-date row (getDailyLoadBySport)", () => {
    const baseline = computeEffectiveMonotony(fixtureOf(wellFormed));
    expect(baseline).not.toBeNull();

    const missingDate = { icu_training_load: 999, type: "Ride" };
    let withMalformed: number | null = null;
    expect(() => {
      withMalformed = computeEffectiveMonotony(fixtureOf([...wellFormed, missingDate]));
    }).not.toThrow();
    expect(withMalformed).toBe(baseline);
  });
});

describe("computePrimarySportMonotony", () => {
  const FROZEN = "2026-05-10T12:00:00";

  // The primary sport is the family with the greatest 7-day Load; the
  // selector uses a strict `total > maxTotal`, so on an exact tie the first
  // family encountered in fixture order wins (mirroring Python's
  // `max(dict, key=dict.get)` insertion-order semantics). No golden fixture
  // hits a deliberate tie, so pin it here.
  it("breaks an exact Load tie toward the first sport family in fixture order", () => {
    // Ride and Run each total 300 over the window but with different daily
    // spreads, so their isolated monotony values differ — which makes the
    // tiebreak observable.
    const rideRows = [
      { start_date_local: "2026-05-04T08:00:00", icu_training_load: 100, type: "Ride" },
      { start_date_local: "2026-05-05T08:00:00", icu_training_load: 100, type: "Ride" },
      { start_date_local: "2026-05-06T08:00:00", icu_training_load: 100, type: "Ride" },
    ];
    const runRows = [
      { start_date_local: "2026-05-07T08:00:00", icu_training_load: 50, type: "Run" },
      { start_date_local: "2026-05-08T08:00:00", icu_training_load: 100, type: "Run" },
      { start_date_local: "2026-05-09T08:00:00", icu_training_load: 150, type: "Run" },
    ];

    const rideMonotony = computePrimarySportMonotony(input(rideRows, FROZEN));
    const runMonotony = computePrimarySportMonotony(input(runRows, FROZEN));

    // Precondition: the two families are distinguishable, so the tiebreak
    // assertions below aren't vacuous.
    expect(rideMonotony).not.toBeNull();
    expect(runMonotony).not.toBeNull();
    expect(rideMonotony).not.toBe(runMonotony);

    // Equal totals → the first-listed family wins, both orderings round.
    expect(computePrimarySportMonotony(input([...rideRows, ...runRows], FROZEN))).toBe(
      rideMonotony,
    );
    expect(computePrimarySportMonotony(input([...runRows, ...rideRows], FROZEN))).toBe(
      runMonotony,
    );
  });
});

describe("computeEffectiveMonotony", () => {
  const FROZEN = "2026-05-10T12:00:00";

  // Selector branch B: a multi-sport window, but the primary sport's own
  // monotony is null (here the highest-Load family has fewer than 3 active
  // days), so the selector falls back to total monotony. Before this, only
  // the interpretation test and the parity matrix touched the selector — the
  // primary-null fallback was never pinned directly.
  it("falls back to total monotony when multi-sport but primary-sport monotony is null", () => {
    const rows = [
      // Ride is the highest-Load family (600) but only 2 active days, so its
      // primary-sport monotony is null (the computer needs ≥ 3).
      { start_date_local: "2026-05-09T08:00:00", icu_training_load: 300, type: "Ride" },
      { start_date_local: "2026-05-10T08:00:00", icu_training_load: 300, type: "Ride" },
      // Run is a second family (so the window is multi-sport) with 3 days.
      { start_date_local: "2026-05-04T08:00:00", icu_training_load: 50, type: "Run" },
      { start_date_local: "2026-05-05T08:00:00", icu_training_load: 50, type: "Run" },
      { start_date_local: "2026-05-06T08:00:00", icu_training_load: 50, type: "Run" },
    ];
    const multiSport = input(rows, FROZEN);

    // Multi-sport (Ride + Run) yet the primary family's monotony is null.
    expect(computePrimarySportMonotony(multiSport)).toBeNull();

    const total = computeMonotony(multiSport);
    expect(total).not.toBeNull();
    expect(computeEffectiveMonotony(multiSport)).toBe(total);
  });
});
