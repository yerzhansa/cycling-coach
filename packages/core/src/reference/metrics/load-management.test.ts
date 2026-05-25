import { describe, expect, it } from "vitest";

import { computeStrain } from "./load-management.js";
import type { MetricInput } from "./metric-input.js";

// computeStrain reads only start_date_local and icu_training_load through
// the shared daily-Load aggregator; the full Activity shape is exercised
// by the parity matrix against golden fixtures. These synthetic rows
// isolate the strain formula and its monotony cascade. `fixture` is typed
// `unknown` at the gate boundary, so minimal rows ride through untyped.
function input(
  activities: { start_date_local: string; icu_training_load: number }[],
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
