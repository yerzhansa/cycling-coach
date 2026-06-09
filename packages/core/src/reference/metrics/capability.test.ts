import { describe, expect, it } from "vitest";

import {
  buildDfaBlock,
  compareTid,
  computeDfaA1Profile,
  computeDurability,
  computeEfficiencyFactor,
  computeHrrc,
  computePowerCurveDelta,
  computeSustainabilityProfile,
  computeTidComparison,
} from "./capability.js";
import type { MetricInput } from "./metric-input.js";
import type {
  ActivityStreams,
  PowerCurveData,
  SustainabilityFamilyCurves,
} from "../schemas/inputs.js";

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

const PCD_NOTE =
  "Compares MMP at 5 anchor durations (5s neuromuscular, 60s anaerobic, " +
  "300s MAP, 1200s threshold, 3600s endurance) across two 28d windows. " +
  "rotation_index = mean(5s,60s pct_change) - mean(1200s,3600s pct_change). " +
  "Positive = sprint-biased gains, negative = endurance-biased. " +
  "300s excluded from rotation (transitional). " +
  "Null when either window has fewer than 3 valid anchor durations.";

// frozenNow=1998-06-04 → current window r.1998-05-08.1998-06-04 (now-27..today),
// previous window r.1998-04-10.1998-05-07 (now-55..now-28). Matches the
// curve-equipped oracle snapshot's window math.
const PCD_FROZEN_NOW = "1998-06-04T12:00:00";
const PCD_CURRENT_ID = "r.1998-05-08.1998-06-04";
const PCD_PREVIOUS_ID = "r.1998-04-10.1998-05-07";

function powerInput(
  powerCurves: PowerCurveData | undefined,
  frozenNow = PCD_FROZEN_NOW,
): MetricInput {
  return {
    fixture: { activities: [], ...(powerCurves ? { power_curves: powerCurves } : {}) },
    frozenNow,
  } as unknown as MetricInput;
}

describe("computePowerCurveDelta", () => {
  it("absent power_curves → dateless null block (the 12-fixture branch)", () => {
    expect(computePowerCurveDelta(powerInput(undefined))).toEqual({
      window_days: 28,
      anchors: null,
      rotation_index: null,
      note: "Insufficient power data in one or both windows.",
    });
  });

  it("empty list → null block but WITH window keys (curves present gates the dates)", () => {
    expect(computePowerCurveDelta(powerInput({ list: [] }))).toEqual({
      window_days: 28,
      current_window: { start: "1998-05-08", end: "1998-06-04" },
      previous_window: { start: "1998-04-10", end: "1998-05-07" },
      anchors: null,
      rotation_index: null,
      note: "Insufficient power data in one or both windows.",
    });
  });

  it("missing-id curve is a silent null branch, named per which window is absent", () => {
    const result = computePowerCurveDelta(
      powerInput({
        list: [{ id: PCD_CURRENT_ID, secs: [5, 60, 1200, 3600], watts: [600, 300, 190, 170] }],
      }),
    );
    expect(result.anchors).toBeNull();
    expect(result.rotation_index).toBeNull();
    expect(result.note).toBe("No power data in previous window(s).");
    expect(result.current_window).toEqual({ start: "1998-05-08", end: "1998-06-04" });
  });

  it("populated: per-anchor pct_change + rotation_index match the curve-equipped oracle", () => {
    const result = computePowerCurveDelta(
      powerInput({
        list: [
          {
            id: PCD_CURRENT_ID,
            secs: [5, 60, 300, 1200, 3600],
            watts: [637, 310, 218, 191, 169],
          },
          {
            id: PCD_PREVIOUS_ID,
            secs: [5, 60, 300, 1200, 3600],
            watts: [564, 259, 195, 167, 157],
          },
        ],
      }),
    );
    expect(result).toEqual({
      window_days: 28,
      current_window: { start: "1998-05-08", end: "1998-06-04" },
      previous_window: { start: "1998-04-10", end: "1998-05-07" },
      anchors: {
        "5s": { current_watts: 637, previous_watts: 564, pct_change: 12.9 },
        "60s": { current_watts: 310, previous_watts: 259, pct_change: 19.7 },
        "300s": { current_watts: 218, previous_watts: 195, pct_change: 11.8 },
        "1200s": { current_watts: 191, previous_watts: 167, pct_change: 14.4 },
        "3600s": { current_watts: 169, previous_watts: 157, pct_change: 7.6 },
      },
      // short mean(12.9,19.7)=16.3, long mean(14.4,7.6)=11.0 → 5.3
      rotation_index: 5.3,
      note: PCD_NOTE,
    });
  });

  it("zero/null watts → anchor null; pct_change null when either side null", () => {
    const result = computePowerCurveDelta(
      powerInput({
        list: [
          { id: PCD_CURRENT_ID, secs: [5, 60, 300, 1200, 3600], watts: [600, 0, 218, 191, 169] },
          { id: PCD_PREVIOUS_ID, secs: [5, 60, 300, 1200, 3600], watts: [564, 259, null, 167, 157] },
        ],
      }),
    );
    // 60s current=0 → not > 0 → current_watts null → pct_change null
    expect(result.anchors?.["60s"]).toEqual({
      current_watts: null,
      previous_watts: 259,
      pct_change: null,
    });
    // 300s previous=null → previous_watts null → pct_change null
    expect(result.anchors?.["300s"]).toEqual({
      current_watts: 218,
      previous_watts: null,
      pct_change: null,
    });
    // current valid = {5s,300s,1200s,3600s}=4, previous valid = {5s,60s,1200s,3600s}=4 → block survives
    // but rotation needs 5s,60s,1200s,3600s all non-null; 60s pct_change null → rotation null
    expect(result.rotation_index).toBeNull();
  });

  it("block guard: < 3 valid anchors in a window → null block with the count message", () => {
    const result = computePowerCurveDelta(
      powerInput({
        list: [
          // current window: only 5s and 60s carry watts → 2 valid (< 3)
          { id: PCD_CURRENT_ID, secs: [5, 60], watts: [600, 300] },
          { id: PCD_PREVIOUS_ID, secs: [5, 60, 300, 1200, 3600], watts: [564, 259, 195, 167, 157] },
        ],
      }),
    );
    expect(result.anchors).toBeNull();
    expect(result.rotation_index).toBeNull();
    expect(result.note).toBe(
      "Too few valid anchors (current: 2, previous: 5, need 3+).",
    );
  });

  it("anchor absent from secs array → that anchor null, others computed", () => {
    const result = computePowerCurveDelta(
      powerInput({
        list: [
          // 60s omitted from secs entirely (not a zero, just not present)
          { id: PCD_CURRENT_ID, secs: [5, 300, 1200, 3600], watts: [637, 218, 191, 169] },
          { id: PCD_PREVIOUS_ID, secs: [5, 60, 300, 1200, 3600], watts: [564, 259, 195, 167, 157] },
        ],
      }),
    );
    expect(result.anchors?.["60s"].current_watts).toBeNull();
    expect(result.anchors?.["5s"].current_watts).toBe(637);
    // 60s pct_change null → rotation null even though block guard (4 valid each) passes
    expect(result.rotation_index).toBeNull();
  });
});

// frozenNow=1998-06-04 → single 42d window r.1998-04-24.1998-06-04
// (now-41..today). Matches the curve-equipped oracle snapshot's window math.
const SUS_FROZEN_NOW = "1998-06-04T12:00:00";
const SUS_CURVE_ID = "r.1998-04-24.1998-06-04";

interface SusWellnessRow {
  id: string;
  weight?: number | null;
}

interface SusAthlete {
  sportSettings: {
    types: string[];
    ftp?: number | null;
    indoor_ftp?: number | null;
    lthr?: number | null;
  }[];
}

function susInput(opts: {
  curves?: Record<string, SustainabilityFamilyCurves>;
  wellness?: SusWellnessRow[];
  athlete?: SusAthlete | null;
  frozenNow?: string;
}): MetricInput {
  const { curves, wellness = [], athlete = null, frozenNow = SUS_FROZEN_NOW } = opts;
  return {
    fixture: {
      activities: [],
      wellness,
      ...(curves ? { sustainability_curves: curves } : {}),
      ...(athlete ? { athlete } : {}),
    },
    frozenNow,
  } as unknown as MetricInput;
}

// A cycling family bundle with Ride (outdoor) + VirtualRide (indoor) power and
// HR curves, both on the single 42d window id. Mirrors the curve-equipped
// fixture's sustainability_curves shape.
function cyclingCurves(over?: {
  rideWatts?: (number | null)[];
  virtualRideWatts?: (number | null)[];
  rideValues?: (number | null)[];
}): Record<string, SustainabilityFamilyCurves> {
  const secs = [300, 600, 1200, 1800, 3600, 5400, 7200];
  const rideWatts = over?.rideWatts ?? [218, 204, 191, 175, 169, 163, 163];
  const virtualRideWatts = over?.virtualRideWatts ?? [218, 204, 191, 175, 169, 163, 163];
  const rideValues = over?.rideValues ?? [176, 173, 171, 169, 162, 160, 155];
  return {
    cycling: {
      power: {
        Ride: { list: [{ id: SUS_CURVE_ID, secs, watts: rideWatts }] },
        VirtualRide: { list: [{ id: SUS_CURVE_ID, secs, watts: virtualRideWatts }] },
      },
      hr: {
        Ride: { list: [{ id: SUS_CURVE_ID, secs, values: rideValues }] },
        VirtualRide: { list: [{ id: SUS_CURVE_ID, secs, values: rideValues }] },
      },
    },
  } as unknown as Record<string, SustainabilityFamilyCurves>;
}

const SUS_ATHLETE: SusAthlete = {
  sportSettings: [{ types: ["Ride", "VirtualRide"], ftp: 200, indoor_ftp: 195, lthr: 168 }],
};

describe("computeSustainabilityProfile", () => {
  it("absent sustainability_curves → bare null block, no window key (the 12-fixture branch)", () => {
    expect(computeSustainabilityProfile(susInput({}))).toEqual({
      note: "No sustainability data available.",
    });
  });

  it("populated cycling block reproduces the curve-equipped oracle anchors", () => {
    const result = computeSustainabilityProfile(
      susInput({
        curves: cyclingCurves(),
        wellness: [{ id: "1998-05-17", weight: 87 }],
        athlete: SUS_ATHLETE,
      }),
    );

    expect(result.window).toEqual({ days: 42, start: "1998-04-24", end: "1998-06-04" });
    expect(result.weight_kg).toBe(87);
    expect(result.weight_source).toBe("wellness_extended");

    const cycling = result.cycling as unknown as {
      anchors: Record<string, Record<string, unknown>>;
      coverage_ratio: number;
      ftp_used: number;
      w_prime_used: number;
      ftp_staleness_days: number | null;
    };
    expect(cycling.coverage_ratio).toBe(1);
    expect(cycling.ftp_used).toBe(200);
    expect(cycling.w_prime_used).toBeNull(); // no wellness sportInfo here → power_model.w_prime null
    expect(cycling.ftp_staleness_days).toBeNull();

    // 1200s: actual 191W, HR 171, wpkg round(191/87,2)=2.2, coggan round(200×0.93)=186,
    // pct_lthr round(171/168×100,1)=101.8, source observed_outdoor (Ride before VirtualRide).
    expect(cycling.anchors["1200s"]).toMatchObject({
      actual_watts: 191,
      actual_hr: 171,
      actual_wpkg: 2.2,
      coggan_watts: 186,
      coggan_wpkg: 2.14,
      pct_lthr: 101.8,
      source: "observed_outdoor",
      // CP/W' model needs w_prime; null here → cp_model_watts + divergence null
      cp_model_watts: null,
      model_divergence_pct: null,
    });
    // 300s coggan round(200×1.06)=212
    expect(cycling.anchors["300s"]).toMatchObject({ coggan_watts: 212, actual_watts: 218 });
  });

  it("CP/W' model layer activates when power_model.w_prime is present (wPrime via sportInfo)", () => {
    const result = computeSustainabilityProfile(
      susInput({
        curves: cyclingCurves(),
        wellness: [
          { id: "1998-05-17", weight: 87 },
          // latest in-window row carries the Ride sportInfo → power model w_prime
          {
            id: "1998-06-04",
            weight: null,
            sportInfo: [{ type: "Ride", eftp: 200, wPrime: 13882, pMax: 727 }],
          } as unknown as SusWellnessRow,
        ],
        athlete: SUS_ATHLETE,
      }),
    );
    const cycling = result.cycling as unknown as {
      w_prime_used: number;
      anchors: Record<string, Record<string, unknown>>;
    };
    expect(cycling.w_prime_used).toBe(13882);
    // cp_model_watts 1200s = round(200 + 13882/1200) = round(211.57) = 212
    // divergence = round((191-212)/212×100,1) = -9.9
    expect(cycling.anchors["1200s"]).toMatchObject({
      cp_model_watts: 212,
      cp_model_wpkg: 2.44,
      model_divergence_pct: -9.9,
    });
    // 300s cp_model = round(200 + 13882/300) = round(246.27) = 246
    expect(cycling.anchors["300s"]).toMatchObject({ cp_model_watts: 246 });
  });

  it("VirtualRide wins an anchor → source flag flips to observed_indoor", () => {
    const result = computeSustainabilityProfile(
      susInput({
        curves: cyclingCurves({
          rideWatts: [218, 204, 191, 175, 169, 163, 163],
          // VirtualRide higher at 300s → indoor wins that anchor
          virtualRideWatts: [230, 204, 191, 175, 169, 163, 163],
        }),
        wellness: [{ id: "1998-05-17", weight: 87 }],
        athlete: SUS_ATHLETE,
      }),
    );
    const cycling = result.cycling as unknown as { anchors: Record<string, Record<string, unknown>> };
    expect(cycling.anchors["300s"]).toMatchObject({
      actual_watts: 230,
      source: "observed_indoor",
    });
    // 600s unchanged → outdoor (Ride encountered first, equal value not > )
    expect(cycling.anchors["600s"]).toMatchObject({ source: "observed_outdoor" });
  });

  it("< 2 observed anchors → null-anchors block with the count note", () => {
    const result = computeSustainabilityProfile(
      susInput({
        curves: cyclingCurves({
          // only 300s carries watts
          rideWatts: [218, null, null, null, null, null, null],
          virtualRideWatts: [218, null, null, null, null, null, null],
        }),
        wellness: [{ id: "1998-05-17", weight: 87 }],
        athlete: SUS_ATHLETE,
      }),
    );
    expect(result.cycling).toMatchObject({
      anchors: null,
      coverage_ratio: 0.14, // round(1/7, 2)
      note: "Too few observed anchors (1, need 2+).",
    });
  });

  it("weight chain: wellness_7d weight wins over the extended window", () => {
    const result = computeSustainabilityProfile(
      susInput({
        curves: cyclingCurves(),
        wellness: [
          { id: "1998-05-17", weight: 80 }, // extended window only
          { id: "1998-06-02", weight: 86 }, // inside 7d window [now-6, today]
        ],
        athlete: SUS_ATHLETE,
      }),
    );
    expect(result.weight_kg).toBe(86);
    expect(result.weight_source).toBe("wellness_recent");
  });

  it("no weight anywhere → null weight, W/kg fields null but watts still observed", () => {
    const result = computeSustainabilityProfile(
      susInput({ curves: cyclingCurves(), wellness: [], athlete: SUS_ATHLETE }),
    );
    expect(result.weight_kg).toBeNull();
    expect(result.weight_source).toBeNull();
    const cycling = result.cycling as unknown as { anchors: Record<string, Record<string, unknown>> };
    expect(cycling.anchors["1200s"]).toMatchObject({ actual_watts: 191, actual_wpkg: null });
  });

  it("non-cycling family (rowing) gets actual MMP only — no model layers", () => {
    const secs = [60, 120, 300, 600, 1200, 1800];
    const rowingCurves = {
      rowing: {
        power: {
          Rowing: { list: [{ id: SUS_CURVE_ID, secs, watts: [400, 380, 320, 300, 280, 270] }] },
        },
        hr: {
          Rowing: { list: [{ id: SUS_CURVE_ID, secs, values: [180, 178, 175, 172, 168, 165] }] },
        },
      },
    } as unknown as Record<string, SustainabilityFamilyCurves>;
    const result = computeSustainabilityProfile(
      susInput({ curves: rowingCurves, wellness: [{ id: "1998-05-17", weight: 80 }] }),
    );
    const rowing = result.rowing as unknown as { anchors: Record<string, Record<string, unknown>> };
    const anchor = rowing.anchors["300s"];
    expect(anchor).toMatchObject({ actual_watts: 320, source: "observed", actual_wpkg: 4 });
    // no cycling-only model keys present on a non-cycling family
    expect(anchor).not.toHaveProperty("coggan_watts");
    expect(anchor).not.toHaveProperty("cp_model_watts");
  });

  it("family not in SUSTAINABILITY_ANCHORS is skipped → null profile if nothing else qualifies", () => {
    const swimCurves = {
      swim: {
        power: { Swim: { list: [{ id: SUS_CURVE_ID, secs: [300], watts: [200] }] } },
        hr: {},
      },
    } as unknown as Record<string, SustainabilityFamilyCurves>;
    expect(computeSustainabilityProfile(susInput({ curves: swimCurves }))).toEqual({
      note: "No sport families produced valid sustainability data.",
      window: { days: 42, start: "1998-04-24", end: "1998-06-04" },
    });
  });
});

// ─── DFA a1 profile ─────────────────────────────────────────────────────────

interface DfaActivityIn {
  id: number;
  start_date_local: string;
  type?: string;
  name?: string;
  moving_time?: number;
  elapsed_time?: number;
}

function dfaInput(opts: {
  activities: DfaActivityIn[];
  streams?: Record<string, ActivityStreams>;
  frozenNow?: string;
}): MetricInput {
  const { activities, streams, frozenNow = "2026-06-04T12:00:00" } = opts;
  return {
    fixture: {
      activities: activities.map((a) => ({
        moving_time: 1800,
        elapsed_time: 1800,
        type: "Ride",
        ...a,
      })),
      wellness: [],
      ftp_history: [],
      ...(streams ? { streams } : {}),
    },
    frozenNow,
  } as unknown as MetricInput;
}

// Reproduces one synthetic dfa-equipped stream: 1800 samples split 600/600/600
// across dfa_a1 = 1.0 / 0.75 / 0.5, with matching HR (138/152/166) and watts
// (175/218/255) plateaus and zero artifacts — a sufficient, steady cycling
// session. The 1.0 plateau lands in the LT1 crossing band (0.95-1.05), the 0.5
// plateau in the LT2 band (0.45-0.55), each well past the 60s dwell gate.
function syntheticDfaStream(): ActivityStreams {
  const rep = (v: number, n: number): number[] => Array.from({ length: n }, () => v);
  return {
    dfa_a1: [...rep(1.0, 600), ...rep(0.75, 600), ...rep(0.5, 600)],
    artifacts: rep(0, 1800),
    heartrate: [...rep(138, 600), ...rep(152, 600), ...rep(166, 600)],
    watts: [...rep(175, 600), ...rep(218, 600), ...rep(255, 600)],
  };
}

describe("buildDfaBlock", () => {
  it("absent dfa_a1 channel → null (no AlphaHRV recording)", () => {
    expect(buildDfaBlock({ heartrate: [140, 141], watts: [200, 201] })).toBeNull();
    expect(buildDfaBlock({ dfa_a1: [] })).toBeNull();
  });

  it("too short → block with quality.sufficient=false and all-null rollups", () => {
    // 100 valid seconds < DFA_MIN_DURATION_SECS (1200).
    const block = buildDfaBlock({
      dfa_a1: Array.from({ length: 100 }, () => 0.8),
      artifacts: Array.from({ length: 100 }, () => 0),
    });
    expect(block).not.toBeNull();
    expect(block!.quality.sufficient).toBe(false);
    expect(block!.quality.valid_secs).toBe(100);
    expect(block!.avg).toBeNull();
    expect(block!.tiz_lt1_transition).toBeNull();
    expect(block!.lt1_crossing).toBeNull();
    expect(block!.aet_crossing).toBeNull();
  });

  it("sentinel zeros (<0.01) and high-artifact seconds are filtered jointly", () => {
    const block = buildDfaBlock({
      dfa_a1: [0.0, 0.8, 0.8, 0.8],
      artifacts: [0, 0, 99, 0], // 3rd second dropped on artifact gate
    });
    // 2 valid of 4 → valid_pct round(100*2/4,1)=50.0; artifact_rate_avg
    // round((0+0+99+0)/4,2)=24.75 over all 4 (artifact sum counts every second).
    expect(block!.quality.valid_secs).toBe(2);
    expect(block!.quality.valid_pct).toBe(50);
    expect(block!.quality.artifact_rate_avg).toBe(24.75);
  });

  it("sufficient steady session → avg + band/crossing rollups (banker's rounding)", () => {
    const block = buildDfaBlock(syntheticDfaStream());
    expect(block!.quality.sufficient).toBe(true);
    expect(block!.quality.valid_pct).toBe(100);
    // avg = round((600·1 + 600·0.75 + 600·0.5)/1800, 3) = round(0.75, 3)
    expect(block!.avg).toBe(0.75);
    // tiz bands: 1.0 → below_lt1 is d>1.0 (none); 1.0 falls in lt1_transition
    // (0.75<=d<=1.0) along with the 0.75 plateau → 1200/1800 = 66.7%.
    expect(block!.tiz_below_lt1).toBeNull();
    expect(block!.tiz_lt1_transition!.pct).toBe(66.7);
    expect(block!.tiz_transition_lt2!.pct).toBe(33.3); // the 0.5 plateau
    expect(block!.tiz_above_lt2).toBeNull();
    // LT1 crossing band 0.95-1.05 catches the 1.0 plateau (600s ≥ 60 dwell).
    expect(block!.lt1_crossing).toEqual({ secs_in_band: 600, avg_hr: 138, avg_watts: 175 });
    // Additive AeT crossing band 0.70-0.80 catches the 0.75 plateau.
    expect(block!.aet_crossing).toEqual({ secs_in_band: 600, avg_hr: 152, avg_watts: 218 });
    // LT2 crossing band 0.45-0.55 catches the 0.5 plateau.
    expect(block!.lt2_crossing).toEqual({ secs_in_band: 600, avg_hr: 166, avg_watts: 255 });
  });
});

describe("computeDfaA1Profile", () => {
  it("no streams → null profile (the 12-fixture branch)", () => {
    expect(
      computeDfaA1Profile(
        dfaInput({ activities: [{ id: 1, start_date_local: "2026-06-03T07:00:00" }] }),
      ),
    ).toBeNull();
  });

  it("streams present but no dfa_a1 channel anywhere → null", () => {
    expect(
      computeDfaA1Profile(
        dfaInput({
          activities: [{ id: 1, start_date_local: "2026-06-03T07:00:00" }],
          streams: { "1": { heartrate: [140], watts: [200] } },
        }),
      ),
    ).toBeNull();
  });

  it("seven sufficient cycling sessions → high confidence, watts split outdoor", () => {
    const dates = [
      "2026-05-28",
      "2026-05-29",
      "2026-05-30",
      "2026-05-31",
      "2026-06-01",
      "2026-06-02",
      "2026-06-03",
    ];
    const ids = [90201, 90202, 90203, 90204, 90205, 90206, 90207];
    const activities = ids.map((id, i) => ({
      id,
      start_date_local: `${dates[i]}T07:00:00`,
      type: "Ride",
      name: "synthetic-dfa-ride",
    }));
    const streams: Record<string, ActivityStreams> = {};
    for (const id of ids) streams[String(id)] = syntheticDfaStream();

    const profile = computeDfaA1Profile(dfaInput({ activities, streams }))!;

    expect(profile.latest_session).toMatchObject({
      activity_id: 90207,
      date: "2026-06-03",
      sport: "Ride",
      validated: true,
      avg: 0.75,
      drift_delta: -0.5,
      drift_interpretable: true,
      quality_pct: 100,
      sufficient: true,
      tiz_split_pct: { below_lt1: 0, lt1_transition: 66.7, transition_lt2: 33.3, above_lt2: 0 },
    });

    const cycling = profile.trailing_by_sport.cycling!;
    expect(cycling.confidence).toBe("high");
    expect(cycling.n_sessions).toBe(7);
    expect(cycling.avg_dfa_a1).toBe(0.75);
    expect(cycling.date_range).toEqual(["2026-05-28", "2026-06-03"]);
    expect(cycling.validated).toBe(true);
    expect(cycling).not.toHaveProperty("note");
    expect(cycling.lt1_estimate).toEqual({
      hr: 138,
      watts_outdoor: 175,
      watts_indoor: null,
      n_sessions: 7,
      n_sessions_outdoor: 7,
      n_sessions_indoor: 0,
    });
    // Additive AeT (0.75) estimate — same cycling indoor/outdoor split shape as
    // lt1, read off the 0.75 plateau (HR 152, watts 218).
    expect(cycling.aet_crossing_sessions).toBe(7);
    expect(cycling.aet_estimate).toEqual({
      hr: 152,
      watts_outdoor: 218,
      watts_indoor: null,
      n_sessions: 7,
      n_sessions_outdoor: 7,
      n_sessions_indoor: 0,
    });
    expect(cycling.lt2_estimate).toEqual({
      hr: 166,
      watts_outdoor: 255,
      watts_indoor: null,
      n_sessions: 7,
      n_sessions_outdoor: 7,
      n_sessions_indoor: 0,
    });
  });

  it("non-cycling family → pooled watts + validated=false with the informational note", () => {
    const dates = [
      "2026-05-28",
      "2026-05-29",
      "2026-05-30",
      "2026-05-31",
      "2026-06-01",
      "2026-06-02",
    ];
    const activities = dates.map((d, i) => ({
      id: 70001 + i,
      start_date_local: `${d}T07:00:00`,
      type: "Rowing",
      name: "synthetic-dfa-row",
    }));
    const streams: Record<string, ActivityStreams> = {};
    for (const a of activities) streams[String(a.id)] = syntheticDfaStream();

    const profile = computeDfaA1Profile(dfaInput({ activities, streams }))!;
    const rowing = profile.trailing_by_sport.rowing!;
    expect(rowing.validated).toBe(false);
    expect(rowing.confidence).toBe("high"); // 6 crossing sessions
    const lt1 = rowing.lt1_estimate as { hr: number; watts: number; n_sessions: number };
    expect(lt1).toEqual({ hr: 138, watts: 175, n_sessions: 6 });
    // Additive AeT estimate for a non-cycling family is pooled-watts shaped.
    expect(rowing.aet_crossing_sessions).toBe(6);
    const aet = rowing.aet_estimate as { hr: number; watts: number; n_sessions: number };
    expect(aet).toEqual({ hr: 152, watts: 218, n_sessions: 6 });
    expect(rowing.note).toContain("cycling-validated");
    // latest_session for a non-cycling sport is validated=false too.
    expect(profile.latest_session.validated).toBe(false);
  });

  it("only insufficient sessions → latest_session sufficient=false, no trailing block", () => {
    // 100 valid seconds is below the 1200s sufficiency floor.
    const shortStream: ActivityStreams = {
      dfa_a1: Array.from({ length: 100 }, () => 0.8),
      artifacts: Array.from({ length: 100 }, () => 0),
      heartrate: Array.from({ length: 100 }, () => 140),
      watts: Array.from({ length: 100 }, () => 200),
    };
    const profile = computeDfaA1Profile(
      dfaInput({
        activities: [
          { id: 1, start_date_local: "2026-06-01T07:00:00", name: "short-a" },
          { id: 2, start_date_local: "2026-06-03T07:00:00", name: "short-b" },
        ],
        streams: { "1": shortStream, "2": shortStream },
      }),
    )!;
    expect(profile.latest_session).toMatchObject({
      activity_id: 2, // most recent
      sufficient: false,
      avg: null,
      tiz_split_pct: null,
    });
    expect(profile.trailing_by_sport).toEqual({});
  });
});
