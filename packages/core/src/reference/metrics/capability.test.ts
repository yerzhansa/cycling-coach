import { describe, expect, it } from "vitest";

import {
  compareTid,
  computeDurability,
  computeEfficiencyFactor,
  computeHrrc,
  computeTidComparison,
} from "./capability.js";
import type { MetricInput } from "./metric-input.js";

interface SyntheticActivity {
  id?: string | number;
  start_date_local: string;
  type?: string;
  moving_time?: number;
  icu_variability_index?: number | null;
  icu_hr_decoupling?: number | null;
  decoupling?: number | null;
  icu_efficiency_factor?: number | null;
  icu_hrr?: number | { value?: number | null; hrr?: number | null } | null;
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

const EF_NOTE =
  "Steady-state cycling sessions only (VI <= 1.05, VI > 0, >= 20min, power+HR data). " +
  "Rising EF = improving aerobic efficiency. Compare like-for-like sessions only — " +
  "EF varies with intensity. Trend compares 7d vs 28d mean (+/-0.03 = stable).";

// A steady-state cycling session that passes the EF _filter_qualifying: EF
// present, a cycling type, 0 < VI <= 1.05, moving_time >= 1200s. `ef` is the
// efficiency-factor value.
function qualifyingEf(date: string, ef: number, type = "Ride"): SyntheticActivity {
  return {
    id: `ef-${date}-${ef}`,
    start_date_local: `${date}T09:00:00`,
    type,
    moving_time: 1800,
    icu_variability_index: 1.0,
    icu_efficiency_factor: ef,
  };
}

describe("computeEfficiencyFactor", () => {
  it("returns the insufficient-sessions shape when no activity qualifies (golden-fixture branch)", () => {
    const result = computeEfficiencyFactor(input([]));
    expect(result).toEqual({
      mean_ef_7d: null,
      mean_ef_28d: null,
      qualifying_sessions_7d: 0,
      qualifying_sessions_28d: 0,
      trend: null,
      note: EF_NOTE,
    });
  });

  it("rejects non-qualifying sessions: non-cycling type, VI out of range, too short, or missing EF", () => {
    const result = computeEfficiencyFactor(
      input([
        { id: 1, start_date_local: "2026-05-08T09:00:00", type: "Run", moving_time: 1800, icu_variability_index: 1.0, icu_efficiency_factor: 2.0 }, // not a cycling type
        { id: 2, start_date_local: "2026-05-08T09:00:00", type: "Ride", moving_time: 1800, icu_variability_index: 1.06, icu_efficiency_factor: 2.0 }, // VI > 1.05
        { id: 3, start_date_local: "2026-05-08T09:00:00", type: "Ride", moving_time: 1800, icu_variability_index: 0, icu_efficiency_factor: 2.0 }, // VI not > 0
        { id: 4, start_date_local: "2026-05-08T09:00:00", type: "Ride", moving_time: 1199, icu_variability_index: 1.0, icu_efficiency_factor: 2.0 }, // < 20 min
        { id: 5, start_date_local: "2026-05-08T09:00:00", type: "Ride", moving_time: 1800, icu_variability_index: 1.0 }, // missing EF
      ]),
    );
    expect(result.qualifying_sessions_7d).toBe(0);
    expect(result.qualifying_sessions_28d).toBe(0);
  });

  it("accepts all four cycling types and rejects other sports", () => {
    const result = computeEfficiencyFactor(
      input([
        qualifyingEf("2026-05-07", 2.0, "Ride"),
        qualifyingEf("2026-05-08", 2.0, "VirtualRide"),
        qualifyingEf("2026-05-09", 2.0, "MountainBikeRide"),
        qualifyingEf("2026-05-10", 2.0, "GravelRide"),
        qualifyingEf("2026-05-10", 9.0, "Swim"), // rejected — not a cycling type
      ]),
    );
    expect(result.qualifying_sessions_7d).toBe(4);
  });

  it("computes means and an improving trend when both windows have >= 2 qualifying sessions", () => {
    const result = computeEfficiencyFactor(
      input([
        // 3 in the 7d window (05-04..05-10)
        qualifyingEf("2026-05-08", 2.5),
        qualifyingEf("2026-05-09", 2.5),
        qualifyingEf("2026-05-10", 2.5),
        // 2 more in 28d-only (04-13..05-03)
        qualifyingEf("2026-04-20", 2.0),
        qualifyingEf("2026-04-25", 2.0),
      ]),
    );
    expect(result.qualifying_sessions_7d).toBe(3);
    expect(result.qualifying_sessions_28d).toBe(5);
    expect(result.mean_ef_7d).toBe(2.5);
    expect(result.mean_ef_28d).toBe(2.3); // (2.5*3 + 2.0*2) / 5 = 11.5 / 5
    expect(result.trend).toBe("improving"); // 2.5 - 2.3 = 0.2 > 0.03
  });

  it("reports a declining trend when the 7d mean drops below the 28d mean by more than 0.03", () => {
    const result = computeEfficiencyFactor(
      input([
        qualifyingEf("2026-05-08", 2.0),
        qualifyingEf("2026-05-09", 2.0),
        qualifyingEf("2026-05-10", 2.0),
        qualifyingEf("2026-04-20", 2.5),
        qualifyingEf("2026-04-25", 2.5),
      ]),
    );
    expect(result.mean_ef_7d).toBe(2.0);
    expect(result.mean_ef_28d).toBe(2.2); // (2.0*3 + 2.5*2) / 5 = 11 / 5
    expect(result.trend).toBe("declining"); // 2.0 - 2.2 = -0.2 < -0.03
  });

  it("reports a stable trend when the 7d and 28d means sit inside the +/-0.03 dead-band", () => {
    const result = computeEfficiencyFactor(
      input([
        qualifyingEf("2026-05-08", 2.0),
        qualifyingEf("2026-05-09", 2.0),
        qualifyingEf("2026-04-20", 2.0),
        qualifyingEf("2026-04-25", 2.0),
      ]),
    );
    expect(result.mean_ef_7d).toBe(2.0);
    expect(result.mean_ef_28d).toBe(2.0);
    expect(result.trend).toBe("stable");
  });

  it("leaves the mean null but counts the session when only one qualifies", () => {
    const result = computeEfficiencyFactor(input([qualifyingEf("2026-05-08", 2.0)]));
    expect(result.qualifying_sessions_7d).toBe(1);
    expect(result.mean_ef_7d).toBeNull(); // needs >= 2
    expect(result.trend).toBeNull();
  });
});

const HRRC_NOTE =
  "HRRc = heart rate recovery (largest 60s HR drop in bpm after exceeding threshold HR for >1 min). " +
  "Higher = better parasympathetic recovery. Null when threshold not reached, recording stopped " +
  "before cooldown, or no HR data. Trend: 7d mean vs 28d mean, >10% = meaningful " +
  "(min 1 session/7d, 3 sessions/28d). Display only — not wired into readiness_decision signals.";

// A session that passes the HRRc _filter_qualifying: HRRc present and > 0.
function qualifyingHrrc(date: string, hrr: number): SyntheticActivity {
  return {
    id: `hrrc-${date}-${hrr}`,
    start_date_local: `${date}T09:00:00`,
    type: "Ride",
    moving_time: 3600,
    icu_hrr: hrr,
  };
}

describe("computeHrrc", () => {
  it("empty → insufficient shape (golden-fixture branch)", () => {
    const result = computeHrrc(input([]));
    expect(result).toEqual({
      mean_hrrc_7d: null,
      mean_hrrc_28d: null,
      qualifying_sessions_7d: 0,
      qualifying_sessions_28d: 0,
      trend: null,
      note: HRRC_NOTE,
    });
  });

  it("dict-form extraction + value/hrr fallback + banker rounding", () => {
    const result = computeHrrc(
      input([
        { start_date_local: "2026-05-08T09:00:00", type: "Ride", moving_time: 3600, icu_hrr: { value: 34 } },
        { start_date_local: "2026-04-20T09:00:00", type: "Ride", moving_time: 3600, icu_hrr: { hrr: 30 } },
        { start_date_local: "2026-04-25T09:00:00", type: "Ride", moving_time: 3600, icu_hrr: { value: null, hrr: 28 } },
      ]),
    );
    expect(result.qualifying_sessions_7d).toBe(1);
    expect(result.qualifying_sessions_28d).toBe(3);
    expect(result.mean_hrrc_7d).toBe(34.0);
    expect(result.mean_hrrc_28d).toBe(30.7);
  });

  it("filter rejects icu_hrr <= 0 and missing", () => {
    const result = computeHrrc(
      input([
        { start_date_local: "2026-05-08T09:00:00", type: "Ride", moving_time: 3600, icu_hrr: 0 },
        { start_date_local: "2026-05-08T09:00:00", type: "Ride", moving_time: 3600, icu_hrr: -5 },
        { start_date_local: "2026-05-08T09:00:00", type: "Ride", moving_time: 3600 },
        qualifyingHrrc("2026-05-08", 25),
      ]),
    );
    expect(result.qualifying_sessions_28d).toBe(1);
  });

  it("7d>=1 emits a mean but 28d<3 stays null", () => {
    const result = computeHrrc(input([qualifyingHrrc("2026-05-08", 35)]));
    expect(result.qualifying_sessions_7d).toBe(1);
    expect(result.mean_hrrc_7d).toBe(35.0);
    expect(result.mean_hrrc_28d).toBeNull();
    expect(result.qualifying_sessions_28d).toBe(1);
    expect(result.trend).toBeNull();
  });

  it("improving trend", () => {
    const result = computeHrrc(
      input([
        qualifyingHrrc("2026-05-08", 40),
        qualifyingHrrc("2026-04-20", 30),
        qualifyingHrrc("2026-04-25", 20),
      ]),
    );
    expect(result.mean_hrrc_7d).toBe(40.0);
    expect(result.mean_hrrc_28d).toBe(30.0);
    expect(result.trend).toBe("improving");
  });

  it("declining trend", () => {
    const result = computeHrrc(
      input([
        qualifyingHrrc("2026-05-08", 26),
        qualifyingHrrc("2026-04-20", 32),
        qualifyingHrrc("2026-04-25", 32),
      ]),
    );
    expect(result.mean_hrrc_7d).toBe(26.0);
    expect(result.mean_hrrc_28d).toBe(30.0);
    expect(result.trend).toBe("declining");
  });

  it("stable trend (inside ±10%)", () => {
    const result = computeHrrc(
      input([
        qualifyingHrrc("2026-05-08", 31),
        qualifyingHrrc("2026-04-20", 30),
        qualifyingHrrc("2026-04-25", 29),
      ]),
    );
    expect(result.mean_hrrc_7d).toBe(31.0);
    expect(result.mean_hrrc_28d).toBe(30.0);
    expect(result.trend).toBe("stable");
  });
});

const TID_NOTE_INSUFFICIENT =
  "Compares 7d vs 28d Seiler TID to detect distribution shifts. Insufficient data in one or both windows.";
const TID_NOTE_FULL =
  "Compares 7d vs 28d Seiler TID to detect distribution shifts. pi_delta positive = more polarized acutely.";

describe("compareTid", () => {
  it("insufficient (cls_7d null)", () => {
    expect(
      compareTid(
        { classification: null, polarization_index: null },
        { classification: "Base", polarization_index: 1.5 },
      ),
    ).toEqual({
      classification_7d: null,
      classification_28d: "Base",
      pi_7d: null,
      pi_28d: 1.5,
      pi_delta: null,
      drift: null,
      note: TID_NOTE_INSUFFICIENT,
    });
  });

  it("consistent (cls equal, pi null)", () => {
    expect(
      compareTid(
        { classification: "Pyramidal", polarization_index: null },
        { classification: "Pyramidal", polarization_index: null },
      ),
    ).toEqual({
      classification_7d: "Pyramidal",
      classification_28d: "Pyramidal",
      pi_7d: null,
      pi_28d: null,
      pi_delta: null,
      drift: "consistent",
      note: TID_NOTE_FULL,
    });
  });

  it("shifting (cls differ, pi null)", () => {
    expect(
      compareTid(
        { classification: "Polarized", polarization_index: null },
        { classification: "Pyramidal", polarization_index: null },
      ),
    ).toEqual({
      classification_7d: "Polarized",
      classification_28d: "Pyramidal",
      pi_7d: null,
      pi_28d: null,
      pi_delta: null,
      drift: "shifting",
      note: TID_NOTE_FULL,
    });
  });

  it("acute_depolarization beats shifting", () => {
    expect(
      compareTid(
        { classification: "Polarized", polarization_index: 1.5 },
        { classification: "Pyramidal", polarization_index: 2.5 },
      ),
    ).toEqual({
      classification_7d: "Polarized",
      classification_28d: "Pyramidal",
      pi_7d: 1.5,
      pi_28d: 2.5,
      pi_delta: -1.0,
      drift: "acute_depolarization",
      note: TID_NOTE_FULL,
    });
  });

  it("acute_depolarization boundary (>= 2.0) beats consistent", () => {
    expect(
      compareTid(
        { classification: "Pyramidal", polarization_index: 1.99 },
        { classification: "Pyramidal", polarization_index: 2.0 },
      ),
    ).toEqual({
      classification_7d: "Pyramidal",
      classification_28d: "Pyramidal",
      pi_7d: 1.99,
      pi_28d: 2.0,
      pi_delta: -0.01,
      drift: "acute_depolarization",
      note: TID_NOTE_FULL,
    });
  });

  it("NOT acute when pi_28d < 2.0", () => {
    expect(
      compareTid(
        { classification: "Base", polarization_index: 1.5 },
        { classification: "Base", polarization_index: 1.8 },
      ),
    ).toEqual({
      classification_7d: "Base",
      classification_28d: "Base",
      pi_7d: 1.5,
      pi_28d: 1.8,
      pi_delta: -0.3,
      drift: "consistent",
      note: TID_NOTE_FULL,
    });
  });

  it("pi_delta banker's tie", () => {
    expect(
      compareTid(
        { classification: "Base", polarization_index: 2.125 },
        { classification: "Base", polarization_index: 2.0 },
      ),
    ).toEqual({
      classification_7d: "Base",
      classification_28d: "Base",
      pi_7d: 2.125,
      pi_28d: 2.0,
      pi_delta: 0.12,
      drift: "consistent",
      note: TID_NOTE_FULL,
    });
  });

  it("pi_delta null when one pi null (cls present)", () => {
    expect(
      compareTid(
        { classification: "Base", polarization_index: 2.0 },
        { classification: "Base", polarization_index: null },
      ),
    ).toEqual({
      classification_7d: "Base",
      classification_28d: "Base",
      pi_7d: 2.0,
      pi_28d: null,
      pi_delta: null,
      drift: "consistent",
      note: TID_NOTE_FULL,
    });
  });

  it("integration", () => {
    expect(computeTidComparison(input([]))).toEqual({
      classification_7d: null,
      classification_28d: null,
      pi_7d: null,
      pi_28d: null,
      pi_delta: null,
      drift: null,
      note: TID_NOTE_INSUFFICIENT,
    });
  });
});
