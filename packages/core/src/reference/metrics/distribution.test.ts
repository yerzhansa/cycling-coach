import { describe, expect, it } from "vitest";

import {
  computeEasyTimeRatio,
  computeEasyTimeRatioNote,
  computeGreyZoneNote,
  computeGreyZonePercentage,
  computeQualityIntensityNote,
  computeQualityIntensityPercentage,
  computeSeilerTid,
  computeSeilerTid28d,
  computeSeilerTidPrimary,
  computeZoneDistribution7d,
} from "./distribution.js";
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

describe("computeGreyZonePercentage", () => {
  it("returns the Z3 share of total zone time, rounded to 1 dp", () => {
    // z1 3600, z2 3600, z3 1800, z4 600 ⇒ total 9600s, z3 share
    // 1800 / 9600 = 0.1875 → 18.75% → round(18.75, 1) = 18.8 (half-to-even).
    const result = computeGreyZonePercentage(
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
            ],
          },
        ],
        FROZEN,
      ),
    );

    expect(result).toBe(18.8);
  });

  it("returns null when no activity has zone time", () => {
    const result = computeGreyZonePercentage(
      input(
        [{ type: "WeightTraining", start_date_local: "2026-05-09T08:00:00" }],
        FROZEN,
      ),
    );

    expect(result).toBeNull();
  });

  it("returns null when the window is empty", () => {
    // The only ride is one day older than the trailing 7-day window.
    const result = computeGreyZonePercentage(
      input(
        [
          {
            type: "Ride",
            start_date_local: "2026-05-03T08:00:00",
            icu_zone_times: [{ id: "Z3", secs: 3600 }],
          },
        ],
        FROZEN,
      ),
    );

    expect(result).toBeNull();
  });
});

describe("computeGreyZoneNote", () => {
  it("returns the static polarized-training note constant", () => {
    expect(computeGreyZoneNote()).toBe(
      "Gray Zone % (Z3/tempo) - minimize in polarized training",
    );
  });
});

describe("computeQualityIntensityPercentage", () => {
  it("returns the Z4+ share of total zone time, rounded to 1 dp", () => {
    // z1 3600, z2 3600, z3 1800, z4 600, z5 600 ⇒ total 10200s,
    // z4_plus 1200s. share 1200 / 10200 = 0.117647… → 11.7647% →
    // round(11.7647, 1) = 11.8.
    const result = computeQualityIntensityPercentage(
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

    expect(result).toBe(11.8);
  });

  it("returns null when no activity has zone time", () => {
    const result = computeQualityIntensityPercentage(
      input(
        [{ type: "WeightTraining", start_date_local: "2026-05-09T08:00:00" }],
        FROZEN,
      ),
    );

    expect(result).toBeNull();
  });

  it("returns null when the window is empty", () => {
    // The only ride is one day older than the trailing 7-day window.
    const result = computeQualityIntensityPercentage(
      input(
        [
          {
            type: "Ride",
            start_date_local: "2026-05-03T08:00:00",
            icu_zone_times: [{ id: "Z4", secs: 3600 }],
          },
        ],
        FROZEN,
      ),
    );

    expect(result).toBeNull();
  });
});

describe("computeQualityIntensityNote", () => {
  it("returns the static polarized-training note constant", () => {
    expect(computeQualityIntensityNote()).toBe(
      "Quality Intensity % (Z4+/threshold+) - target ~20% in polarized training",
    );
  });
});

describe("computeEasyTimeRatio", () => {
  it("returns the (Z1+Z2) share of total zone time as a bare ratio, rounded to 2 dp", () => {
    // z1 3600, z2 3600, z3 1800, z4 600, z5 600 ⇒ total 10200s,
    // easy 7200s. ratio 7200 / 10200 = 0.70588… → round(…, 2) = 0.71.
    const result = computeEasyTimeRatio(
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

    expect(result).toBe(0.71);
  });

  it("rounds half-to-even at the 2-dp boundary like Python's round", () => {
    // easy 1250s, total 5000s ⇒ 0.25 exactly — no boundary. Use easy 1500s,
    // total 4000s ⇒ 0.375 → round(0.375, 2) half-to-even = 0.38.
    const result = computeEasyTimeRatio(
      input(
        [
          {
            type: "Ride",
            start_date_local: "2026-05-09T08:00:00",
            icu_zone_times: [
              { id: "Z1", secs: 1500 },
              { id: "Z4", secs: 2500 },
            ],
          },
        ],
        FROZEN,
      ),
    );

    expect(result).toBe(0.38);
  });

  it("returns null when no activity has zone time", () => {
    const result = computeEasyTimeRatio(
      input(
        [{ type: "WeightTraining", start_date_local: "2026-05-09T08:00:00" }],
        FROZEN,
      ),
    );

    expect(result).toBeNull();
  });

  it("returns null when the window is empty", () => {
    // The only ride is one day older than the trailing 7-day window.
    const result = computeEasyTimeRatio(
      input(
        [
          {
            type: "Ride",
            start_date_local: "2026-05-03T08:00:00",
            icu_zone_times: [{ id: "Z1", secs: 3600 }],
          },
        ],
        FROZEN,
      ),
    );

    expect(result).toBeNull();
  });
});

describe("computeEasyTimeRatioNote", () => {
  it("returns the static polarized-training note constant", () => {
    expect(computeEasyTimeRatioNote()).toBe(
      "Easy time (Z1+Z2) / Total - target ~80% in polarized training",
    );
  });
});

describe("computeSeilerTid", () => {
  // The seven-zone fold into Seiler's model: SeilerZ1 = z1+z2,
  // SeilerZ2 = z3, SeilerZ3 = z4+z5+z6+z7. The golden fixtures only land
  // the Pyramidal-with-null-PI branch; these synthetic rows isolate the
  // classification and polarization-index branches the parity matrix can't
  // reach.

  it("folds seven zones into the Seiler 3-zone model and classifies Pyramidal (PI null)", () => {
    // SeilerZ1 = 5000+1000 = 6000, SeilerZ2 = 3000, SeilerZ3 = 1000.
    // total 10000 ⇒ fracs 0.6/0.3/0.1. z1>z2>z3 ⇒ Pyramidal. PI null
    // because the polarized gate (z1>z3>z2) fails (z3 0.1 < z2 0.3).
    const result = computeSeilerTid(
      input(
        [
          {
            type: "Ride",
            start_date_local: "2026-05-09T08:00:00",
            icu_zone_times: [
              { id: "Z1", secs: 5000 },
              { id: "Z2", secs: 1000 },
              { id: "Z3", secs: 3000 },
              { id: "Z4", secs: 1000 },
            ],
          },
        ],
        FROZEN,
      ),
    );

    expect(result).toEqual({
      z1_seconds: 6000,
      z2_seconds: 3000,
      z3_seconds: 1000,
      z1_pct: 60,
      z2_pct: 30,
      z3_pct: 10,
      polarization_index: null,
      classification: "Pyramidal",
      zone_basis: "power",
    });
  });

  it("computes the Treff polarization index and classifies Polarized when Z1>Z3>Z2 and PI>2.0", () => {
    // SeilerZ1 = 7500, SeilerZ2 = 500, SeilerZ3 = 2000. fracs 0.75/0.05/0.20.
    // PI = log10((0.75/0.05) × 0.20 × 100) = log10(300) = 2.48 > 2.0.
    const result = computeSeilerTid(
      input(
        [
          {
            type: "Ride",
            start_date_local: "2026-05-09T08:00:00",
            icu_zone_times: [
              { id: "Z1", secs: 7500 },
              { id: "Z3", secs: 500 },
              { id: "Z4", secs: 2000 },
            ],
          },
        ],
        FROZEN,
      ),
    );

    expect(result.polarization_index).toBe(2.48);
    expect(result.classification).toBe("Polarized");
    expect(result.z1_pct).toBe(75);
    expect(result.z2_pct).toBe(5);
    expect(result.z3_pct).toBe(20);
  });

  it("substitutes Z2=0 with 0.01 in the PI formula", () => {
    // SeilerZ1 = 8000, SeilerZ2 = 0, SeilerZ3 = 2000. fracs 0.8/0.0/0.20.
    // z1>z3>z2 (0.8>0.2>0); effective Z2 = 0.01.
    // PI = log10((0.8/0.01) × 0.20 × 100) = log10(1600) = 3.2 > 2.0.
    const result = computeSeilerTid(
      input(
        [
          {
            type: "Ride",
            start_date_local: "2026-05-09T08:00:00",
            icu_zone_times: [
              { id: "Z1", secs: 8000 },
              { id: "Z4", secs: 2000 },
            ],
          },
        ],
        FROZEN,
      ),
    );

    expect(result.z2_seconds).toBe(0);
    expect(result.z2_pct).toBe(0);
    expect(result.polarization_index).toBe(3.2);
    expect(result.classification).toBe("Polarized");
  });

  it("falls back to Pyramidal when the structure is polarized but PI <= 2.0", () => {
    // SeilerZ1 = 5000, SeilerZ2 = 2000, SeilerZ3 = 3000. fracs 0.5/0.2/0.3.
    // z1>z3>z2 so the PI gate opens; PI = log10((0.5/0.2) × 0.3 × 100) =
    // log10(75) = 1.88 ≤ 2.0, so not Polarized. Pyramidal needs z1>z2>z3
    // (fails: z3 0.3 > z2 0.2), and Z2/Z3 aren't dominant ⇒ final fallback.
    const result = computeSeilerTid(
      input(
        [
          {
            type: "Ride",
            start_date_local: "2026-05-09T08:00:00",
            icu_zone_times: [
              { id: "Z1", secs: 5000 },
              { id: "Z3", secs: 2000 },
              { id: "Z4", secs: 3000 },
            ],
          },
        ],
        FROZEN,
      ),
    );

    expect(result.polarization_index).toBe(1.88);
    expect(result.classification).toBe("Pyramidal");
  });

  it("classifies Base when Z3 is near zero and Z1 dominates", () => {
    // SeilerZ1 = 9900, SeilerZ2 = 100, SeilerZ3 = 0. fracs 0.99/0.01/0.0.
    // z3_frac 0 < 0.01 and z1 dominant ⇒ Base; PI null (z3 < 0.01).
    const result = computeSeilerTid(
      input(
        [
          {
            type: "Ride",
            start_date_local: "2026-05-09T08:00:00",
            icu_zone_times: [
              { id: "Z1", secs: 9900 },
              { id: "Z3", secs: 100 },
            ],
          },
        ],
        FROZEN,
      ),
    );

    expect(result.classification).toBe("Base");
    expect(result.polarization_index).toBeNull();
    expect(result.z3_seconds).toBe(0);
  });

  it("classifies Threshold when Seiler Z2 (tempo) dominates", () => {
    // SeilerZ1 = 2000, SeilerZ2 = 6000, SeilerZ3 = 2000. fracs 0.2/0.6/0.2.
    const result = computeSeilerTid(
      input(
        [
          {
            type: "Ride",
            start_date_local: "2026-05-09T08:00:00",
            icu_zone_times: [
              { id: "Z1", secs: 2000 },
              { id: "Z3", secs: 6000 },
              { id: "Z4", secs: 2000 },
            ],
          },
        ],
        FROZEN,
      ),
    );

    expect(result.classification).toBe("Threshold");
    expect(result.polarization_index).toBeNull();
  });

  it("classifies High Intensity when Seiler Z3 (hard) dominates", () => {
    // SeilerZ1 = 2000, SeilerZ2 = 2000, SeilerZ3 = 6000. fracs 0.2/0.2/0.6.
    const result = computeSeilerTid(
      input(
        [
          {
            type: "Ride",
            start_date_local: "2026-05-09T08:00:00",
            icu_zone_times: [
              { id: "Z1", secs: 2000 },
              { id: "Z3", secs: 2000 },
              { id: "Z4", secs: 6000 },
            ],
          },
        ],
        FROZEN,
      ),
    );

    expect(result.classification).toBe("High Intensity");
    expect(result.polarization_index).toBeNull();
  });

  it("returns zero seconds and null fields when total zone time is zero", () => {
    const result = computeSeilerTid(
      input(
        [{ type: "WeightTraining", start_date_local: "2026-05-09T08:00:00" }],
        FROZEN,
      ),
    );

    expect(result).toEqual({
      z1_seconds: 0,
      z2_seconds: 0,
      z3_seconds: 0,
      z1_pct: null,
      z2_pct: null,
      z3_pct: null,
      polarization_index: null,
      classification: null,
      zone_basis: null,
    });
  });
});

describe("computeSeilerTidPrimary", () => {
  // The golden fixtures are cycling-only, so the sport-family filter is a
  // no-op there and the primary variant equals the all-sport one (plus the
  // sport key). These synthetic rows isolate the multi-sport branches the
  // parity matrix can't reach: primary selection by Load, the filter
  // excluding non-primary activities, the insertion-order tiebreak, and the
  // null path when no activity carries Load.

  it("restricts aggregation to the highest-Load family and appends its name as sport", () => {
    // Cycling Load 100 > Run Load 50 ⇒ primary = cycling. Only the ride
    // enters the aggregation; the run's all-hard HR zones (which would push
    // SeilerZ3 to 9000 and flip the basis to mixed) are excluded. SeilerZ1
    // = 5000+1000, SeilerZ2 = 3000, SeilerZ3 = 1000 ⇒ 0.6/0.3/0.1 Pyramidal.
    const result = computeSeilerTidPrimary(
      input(
        [
          {
            type: "Ride",
            icu_training_load: 100,
            start_date_local: "2026-05-09T08:00:00",
            icu_zone_times: [
              { id: "Z1", secs: 5000 },
              { id: "Z2", secs: 1000 },
              { id: "Z3", secs: 3000 },
              { id: "Z4", secs: 1000 },
            ],
          },
          {
            type: "Run",
            icu_training_load: 50,
            start_date_local: "2026-05-08T08:00:00",
            icu_hr_zone_times: [0, 0, 0, 9000],
          },
        ],
        FROZEN,
      ),
    );

    expect(result).toEqual({
      z1_seconds: 6000,
      z2_seconds: 3000,
      z3_seconds: 1000,
      z1_pct: 60,
      z2_pct: 30,
      z3_pct: 10,
      polarization_index: null,
      classification: "Pyramidal",
      zone_basis: "power",
      sport: "cycling",
    });
  });

  it("breaks a Load tie in favour of the first-encountered family", () => {
    // Run and Ride both carry Load 100. `max(sport_totals, key=...)` returns
    // the first key at the maximum in insertion order, so the run (listed
    // first) wins. Only its HR zones enter: SeilerZ1 = 6000+3000, SeilerZ2 =
    // 1000, SeilerZ3 = 0 ⇒ 0.9/0.1/0.0 ⇒ Base; sport "run", basis "hr".
    const result = computeSeilerTidPrimary(
      input(
        [
          {
            type: "Run",
            icu_training_load: 100,
            start_date_local: "2026-05-08T08:00:00",
            icu_hr_zone_times: [6000, 3000, 1000],
          },
          {
            type: "Ride",
            icu_training_load: 100,
            start_date_local: "2026-05-09T08:00:00",
            icu_zone_times: [{ id: "Z4", secs: 9000 }],
          },
        ],
        FROZEN,
      ),
    );

    expect(result?.sport).toBe("run");
    expect(result?.zone_basis).toBe("hr");
    expect(result?.classification).toBe("Base");
    expect(result?.z3_seconds).toBe(0);
  });

  it("returns null when no in-window activity carries Load (even with zone data)", () => {
    // Zone data is present but Load is 0, so the upstream `primary_sport`
    // stays None and the variant is never built — null, unlike the all-sport
    // metric which would still aggregate the zone time.
    const rows = [
      {
        type: "Ride",
        icu_training_load: 0,
        start_date_local: "2026-05-09T08:00:00",
        icu_zone_times: [{ id: "Z1", secs: 3600 }],
      },
    ];

    expect(computeSeilerTidPrimary(input(rows, FROZEN))).toBeNull();
    // The all-sport variant still has data — confirming the null is the
    // primary-sport gate, not an empty window.
    expect(computeSeilerTid(input(rows, FROZEN)).z1_seconds).toBe(3600);
  });

  it("equals the all-sport build plus the sport key for a single-family window", () => {
    const rows = [
      {
        type: "Ride",
        icu_training_load: 80,
        start_date_local: "2026-05-09T08:00:00",
        icu_zone_times: [
          { id: "Z1", secs: 5000 },
          { id: "Z3", secs: 3000 },
          { id: "Z4", secs: 2000 },
        ],
      },
      {
        type: "VirtualRide",
        icu_training_load: 40,
        start_date_local: "2026-05-08T08:00:00",
        icu_zone_times: [{ id: "Z2", secs: 1000 }],
      },
    ];

    const all = computeSeilerTid(input(rows, FROZEN));
    const primary = computeSeilerTidPrimary(input(rows, FROZEN));

    expect(primary).toEqual({ ...all, sport: "cycling" });
  });
});

describe("computeSeilerTid28d", () => {
  // The golden fixtures are cycling-only, so the parity matrix already
  // exercises the 28d window against the snapshot. These synthetic rows
  // isolate the one thing that distinguishes this from the 7d variant: the
  // wider aggregation window. The Seiler fold / PI / classifier logic is the
  // shared `buildSeilerTid` substrate already covered by `computeSeilerTid`.

  it("aggregates an activity that falls outside the 7d window but inside 28d", () => {
    // FROZEN 2026-05-10: the 7d window is [05-04, 05-10], the 28d window is
    // [04-13, 05-10]. The 04-25 ride is too old for 7d but in-window for 28d.
    // SeilerZ1 = 5000+1000 = 6000, SeilerZ2 = 3000, SeilerZ3 = 1000.
    // total 10000 ⇒ 0.6/0.3/0.1 ⇒ Pyramidal, PI null.
    const rows = [
      {
        type: "Ride",
        start_date_local: "2026-04-25T08:00:00",
        icu_zone_times: [
          { id: "Z1", secs: 5000 },
          { id: "Z2", secs: 1000 },
          { id: "Z3", secs: 3000 },
          { id: "Z4", secs: 1000 },
        ],
      },
    ];

    expect(computeSeilerTid28d(input(rows, FROZEN))).toEqual({
      z1_seconds: 6000,
      z2_seconds: 3000,
      z3_seconds: 1000,
      z1_pct: 60,
      z2_pct: 30,
      z3_pct: 10,
      polarization_index: null,
      classification: "Pyramidal",
      zone_basis: "power",
    });
    // The same row is empty for the 7d builder — confirming the only
    // difference is the window, not the aggregation.
    expect(computeSeilerTid(input(rows, FROZEN)).z1_seconds).toBe(0);
  });

  it("excludes activities older than the trailing 28-day window", () => {
    // 04-12 is one day older than the 28d window [04-13, 05-10].
    const result = computeSeilerTid28d(
      input(
        [
          {
            type: "Ride",
            start_date_local: "2026-04-12T08:00:00",
            icu_zone_times: [{ id: "Z2", secs: 3600 }],
          },
        ],
        FROZEN,
      ),
    );

    expect(result.z1_seconds).toBe(0);
    expect(result.z2_seconds).toBe(0);
    expect(result.z3_seconds).toBe(0);
    expect(result.zone_basis).toBeNull();
  });

  it("returns zero seconds and null fields when total zone time is zero", () => {
    const result = computeSeilerTid28d(
      input(
        [{ type: "WeightTraining", start_date_local: "2026-04-25T08:00:00" }],
        FROZEN,
      ),
    );

    expect(result).toEqual({
      z1_seconds: 0,
      z2_seconds: 0,
      z3_seconds: 0,
      z1_pct: null,
      z2_pct: null,
      z3_pct: null,
      polarization_index: null,
      classification: null,
      zone_basis: null,
    });
  });
});
