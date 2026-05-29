import { describe, expect, it } from "vitest";

import { computeDurability } from "./capability.js";
import type { MetricInput } from "./metric-input.js";

interface SyntheticActivity {
  id?: string | number;
  start_date_local: string;
  type?: string;
  moving_time?: number;
  icu_variability_index?: number | null;
  icu_hr_decoupling?: number | null;
  decoupling?: number | null;
}

function input(activities: SyntheticActivity[], frozenNow = "2026-05-10T12:00:00"): MetricInput {
  return { fixture: { activities }, frozenNow } as unknown as MetricInput;
}

// A steady-state session that passes _filter_qualifying: decoupling present,
// 0 < VI <= 1.05, moving_time >= 5400s. `dec` is the decoupling value.
function qualifying(date: string, dec: number): SyntheticActivity {
  return {
    id: `q-${date}-${dec}`,
    start_date_local: `${date}T09:00:00`,
    type: "Ride",
    moving_time: 6000,
    icu_variability_index: 1.0,
    icu_hr_decoupling: dec,
  };
}

const NOTE =
  "Steady-state power sessions only (VI <= 1.05, VI > 0, >= 90min, power data). " +
  "Negative decoupling = strong durability. Trend compares 7d vs 28d mean " +
  "(+/-1% = stable). Alerts require N28>=5 (alarm) or N7>=3 AND N28>=5 " +
  "(declining warning) for statistical reliability.";

describe("computeDurability", () => {
  it("returns the insufficient-sessions shape when no activity qualifies (golden-fixture branch)", () => {
    const result = computeDurability(input([]));
    expect(result).toEqual({
      mean_decoupling_7d: null,
      mean_decoupling_28d: null,
      high_drift_count_7d: 0,
      high_drift_count_28d: 0,
      qualifying_sessions_7d: 0,
      qualifying_sessions_28d: 0,
      trend: null,
      reliability_limited: true,
      reliability_note: "insufficient qualifying sessions for alert evaluation: 7d N=0 (min 3), 28d N=0 (min 5)",
      note: NOTE,
    });
  });

  it("rejects non-qualifying sessions: VI out of range, too short, or missing decoupling", () => {
    const result = computeDurability(
      input([
        { id: 1, start_date_local: "2026-05-08T09:00:00", type: "Ride", moving_time: 6000, icu_variability_index: 1.06, icu_hr_decoupling: 2 }, // VI > 1.05
        { id: 2, start_date_local: "2026-05-08T09:00:00", type: "Ride", moving_time: 6000, icu_variability_index: 0, icu_hr_decoupling: 2 }, // VI not > 0
        { id: 3, start_date_local: "2026-05-08T09:00:00", type: "Ride", moving_time: 5399, icu_variability_index: 1.0, icu_hr_decoupling: 2 }, // < 90 min
        { id: 4, start_date_local: "2026-05-08T09:00:00", type: "Ride", moving_time: 6000, icu_variability_index: 1.0 }, // no decoupling
      ]),
    );
    expect(result.qualifying_sessions_7d).toBe(0);
    expect(result.qualifying_sessions_28d).toBe(0);
  });

  it("prefers icu_hr_decoupling, falls back to decoupling when it is null", () => {
    const result = computeDurability(
      input([
        { id: 1, start_date_local: "2026-05-08T09:00:00", type: "Ride", moving_time: 6000, icu_variability_index: 1.0, icu_hr_decoupling: null, decoupling: 3.0 },
        { id: 2, start_date_local: "2026-05-09T09:00:00", type: "Ride", moving_time: 6000, icu_variability_index: 1.0, icu_hr_decoupling: 1.0, decoupling: 99 },
      ]),
    );
    // dec values are [3.0 (fallback), 1.0 (preferred)] → mean 2.0
    expect(result.qualifying_sessions_7d).toBe(2);
    expect(result.mean_decoupling_7d).toBe(2.0);
  });

  it("computes means/trend/high-drift and clears the reliability gate when N28>=5 and N7>=3", () => {
    const result = computeDurability(
      input([
        // 3 in the 7d window (05-04..05-10), all also in 28d
        qualifying("2026-05-08", 2.0),
        qualifying("2026-05-09", 4.0),
        qualifying("2026-05-10", 6.0), // > 5.0 → high drift
        // 2 more in 28d-only (04-13..05-03)
        qualifying("2026-04-20", 1.0),
        qualifying("2026-04-25", 1.0),
      ]),
    );
    expect(result.qualifying_sessions_7d).toBe(3);
    expect(result.qualifying_sessions_28d).toBe(5);
    expect(result.mean_decoupling_7d).toBe(4.0); // (2+4+6)/3
    expect(result.mean_decoupling_28d).toBe(2.8); // (2+4+6+1+1)/5
    expect(result.high_drift_count_7d).toBe(1); // only 6.0 > 5.0
    expect(result.high_drift_count_28d).toBe(1);
    expect(result.trend).toBe("declining"); // 4.0 - 2.8 = 1.2 > 1.0
    expect(result.reliability_limited).toBe(false);
    expect(result.reliability_note).toBeNull();
  });

  it("leaves the mean null but counts the session when only one qualifies", () => {
    const result = computeDurability(input([qualifying("2026-05-08", 2.0)]));
    expect(result.qualifying_sessions_7d).toBe(1);
    expect(result.mean_decoupling_7d).toBeNull(); // needs >= 2
    expect(result.reliability_limited).toBe(true);
  });
});
