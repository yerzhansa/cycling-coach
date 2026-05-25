import { describe, expect, it } from "vitest";

import { computeZoneDistribution7d } from "./distribution.js";
import type { MetricInput } from "./metric-input.js";

// The golden fixtures only exercise the power-zone and empty-window paths,
// so these synthetic rows isolate the substrate branches the parity matrix
// can't reach: HR fallback, mixed basis, no-zone-data, the z4+ fold, and
// the trailing-window cutoff. `fixture` is typed `unknown` at the gate
// boundary, so minimal rows — including the flat `icu_hr_zone_times` array
// that isn't on the typed Activity surface — ride through untyped.
function input(activities: unknown[], frozenNow: string): MetricInput {
  return { fixture: { activities }, frozenNow };
}

const FROZEN = "2026-05-10T12:00:00";

describe("computeZoneDistribution7d", () => {
  it("sums power zones into hours and folds z4..z7 into z4_plus", () => {
    // One in-window Ride: z1 3600, z2 3600, z3 1800, z4 600, z5 600.
    // total 10200s. z4_plus = 600 + 600 = 1200s.
    const result = computeZoneDistribution7d(
      input(
        [
          {
            type: "Ride",
            start_date_local: "2026-05-09T08:00:00",
            icu_zone_times: [
              { id: "Z1", secs: 3600 },
              { id: "Z2", secs: 3600 },
              { id: "Z3", secs: 1800 },
              { id: "Z4", secs: 600 },
              { id: "Z5", secs: 600 },
            ],
          },
        ],
        FROZEN,
      ),
    );

    expect(result).toEqual({
      total_hours: 2.83, // 10200 / 3600 = 2.8333… → 2.83
      z1_hours: 1,
      z2_hours: 1,
      z3_hours: 0.5,
      z4_plus_hours: 0.33, // 1200 / 3600 = 0.3333… → 0.33
      zone_basis: "power",
    });
  });

  it("falls back to HR zones (flat seconds array) when no power zones", () => {
    // icu_hr_zone_times is index-mapped to z1..z7; the 0-second bin is
    // skipped. z1 720, z3 1800, z4 600 ⇒ total 3120s, z4_plus 600s.
    const result = computeZoneDistribution7d(
      input(
        [
          {
            type: "Run",
            start_date_local: "2026-05-08T08:00:00",
            icu_hr_zone_times: [720, 0, 1800, 600],
          },
        ],
        FROZEN,
      ),
    );

    expect(result.zone_basis).toBe("hr");
    expect(result.total_hours).toBe(0.87); // 3120 / 3600 = 0.8666… → 0.87
    expect(result.z2_hours).toBe(0); // the 0-second z2 bin was skipped
    expect(result.z4_plus_hours).toBe(0.17); // 600 / 3600 = 0.1666… → 0.17
  });

  it("reports mixed basis when power- and HR-based activities both contribute", () => {
    const result = computeZoneDistribution7d(
      input(
        [
          {
            type: "Ride",
            start_date_local: "2026-05-09T08:00:00",
            icu_zone_times: [{ id: "Z2", secs: 3600 }],
          },
          {
            type: "Run",
            start_date_local: "2026-05-08T08:00:00",
            icu_hr_zone_times: [3600],
          },
        ],
        FROZEN,
      ),
    );

    expect(result.zone_basis).toBe("mixed");
    expect(result.total_hours).toBe(2); // 3600 + 3600 = 7200s = 2h
  });

  it("returns all-zero hours and null basis when no activity has zone data", () => {
    const result = computeZoneDistribution7d(
      input(
        [
          { type: "WeightTraining", start_date_local: "2026-05-09T08:00:00" },
        ],
        FROZEN,
      ),
    );

    expect(result).toEqual({
      total_hours: 0,
      z1_hours: 0,
      z2_hours: 0,
      z3_hours: 0,
      z4_plus_hours: 0,
      zone_basis: null,
    });
  });

  it("excludes activities outside the trailing 7-day window", () => {
    // Window is 2026-05-04..2026-05-10. The 05-03 ride is one day too old.
    const result = computeZoneDistribution7d(
      input(
        [
          {
            type: "Ride",
            start_date_local: "2026-05-03T08:00:00",
            icu_zone_times: [{ id: "Z2", secs: 3600 }],
          },
        ],
        FROZEN,
      ),
    );

    expect(result.total_hours).toBe(0);
    expect(result.zone_basis).toBeNull();
  });
});
