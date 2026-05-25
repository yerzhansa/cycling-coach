import { describe, expect, it } from "vitest";

import {
  computeEffectiveMonotony,
  computeMonotony,
  computeMonotonyInterpretation,
  computeStrain,
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
