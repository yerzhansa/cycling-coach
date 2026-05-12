// The load-bearing claim under test: schemas use `z.looseObject()` so real
// intervals.icu data with TP-trademark fields (`icu_atl`, `icu_ctl`, etc.)
// rides through unmodified — preserving signal metric computers may opt to
// read, without leaking the trademark vocabulary into typed-IntelliSense.
//
// The trademark-wall mechanical assertion lives in the sibling file
// `reference-input-schemas-no-tp.test.ts`.

import { describe, it, expect } from "vitest";

import {
  ActivitySchema,
  WellnessDaySchema,
  WeeklyRollupSchema,
  FtpHistoryPointSchema,
  PlannedEventSchema,
  IcuIntervalRepSchema,
  ZoneTimesSchema,
} from "../src/reference/schemas/inputs.js";

describe("ActivitySchema (z.looseObject)", () => {
  it("round-trips a realistic intervals.icu activity preserving every field, including TP-trademark fields", () => {
    const realisticActivity = {
      // Identity + timing
      id: 17654321,
      start_date_local: "2026-04-15T07:30:00",
      type: "Ride",
      moving_time: 5400,
      elapsed_time: 5650,

      // Load + intensity (named in the schema)
      icu_training_load: 142,
      icu_intensity: 0.82,

      // Power + HR (named, nullable)
      average_watts: 218,
      average_heartrate: 148,

      // Zone-time breakdowns (named, optional)
      icu_zone_times: [600, 1800, 2400, 540, 60, 0, 0],
      pace_zone_times: undefined,
      hr_zone_times: [500, 1700, 2600, 540, 60, 0, 0],

      // Capability proxies (named, optional)
      decoupling: 4.2,
      pa_hr: 3.1,
      icu_efficiency_factor: 1.46,
      icu_intervals: [
        { type: "WORK", duration: 1200, average_watts: 280, average_heartrate: 165 },
        { type: "RECOVERY", duration: 300, average_watts: 120, average_heartrate: 110 },
      ],

      // Compliance (named, optional)
      paired_event_id: 8899,
      rpe: 6,

      // Energy / output (named, optional)
      kj: 1180,

      // Trademark-banned fields the *typed shape* excludes by name —
      // present on real intervals.icu payloads. z.looseObject MUST preserve them
      // verbatim or the `derived_metrics.compliance` cross-check loses signal.
      icu_atl: 38.4,
      icu_ctl: 52.1,
      tsb: 13.7,

      // Random extra fields intervals.icu may add over time (forward-compat).
      vendor_id: "intervals.icu",
      stream_url: "https://intervals.icu/api/v1/activity/17654321/streams",
    };

    expect(ActivitySchema.parse(realisticActivity)).toEqual(realisticActivity);
  });

  it("accepts an Activity with no power meter (average_watts absent, icu_training_load absent)", () => {
    // Real-world case: WeightTraining session, no power data, no load score.
    // The lib's own ActivitySchema marks these nullish; we mirror that so
    // a real intervals.icu payload rides through the looseObject promise.
    const noPowerActivity = {
      id: 17654322,
      start_date_local: "2026-04-15T18:00:00",
      type: "WeightTraining",
      moving_time: 2700,
      elapsed_time: 2900,
      average_heartrate: 122,
    };
    expect(ActivitySchema.parse(noPowerActivity)).toEqual(noPowerActivity);
  });

  it("accepts an Activity whose id is the string form 'i<digits>' (the API uses this shape on some endpoints)", () => {
    const stringIdActivity = {
      id: "i146622609",
      start_date_local: "2026-04-15T07:30:00",
      type: "Ride",
      moving_time: 5400,
      elapsed_time: 5650,
      icu_training_load: 142,
    };
    expect(ActivitySchema.parse(stringIdActivity)).toEqual(stringIdActivity);
  });

  it("accepts an Activity whose pace_zone_times is null (API writes null, not absent, when the series is unavailable)", () => {
    const nullZoneActivity = {
      id: "i146400073",
      start_date_local: "2026-04-15T07:30:00",
      type: "Ride",
      moving_time: 5400,
      elapsed_time: 5650,
      pace_zone_times: null,
      hr_zone_times: null,
    };
    expect(ActivitySchema.parse(nullZoneActivity)).toEqual(nullZoneActivity);
  });

  it("accepts an Activity whose icu_zone_times uses the object form {id, secs} (the API's native bin shape)", () => {
    const objectFormActivity = {
      id: 17654323,
      start_date_local: "2026-04-15T07:30:00",
      type: "Ride",
      moving_time: 5400,
      elapsed_time: 5650,
      icu_training_load: 142,
      icu_intensity: 0.82,
      average_heartrate: 148,
      icu_zone_times: [
        { id: "Z1", secs: 600 },
        { id: "Z2", secs: 1800 },
        { id: "Z3", secs: 2400 },
      ],
      hr_zone_times: [{ id: "Z1", secs: 500 }, { id: "Z2", secs: 1700 }],
    };
    expect(ActivitySchema.parse(objectFormActivity)).toEqual(objectFormActivity);
  });
});

describe("WellnessDaySchema (z.looseObject)", () => {
  it("round-trips a realistic intervals.icu wellness day preserving every field, including TP-trademark fields", () => {
    const realisticWellness = {
      id: "2026-04-15",
      weight: 73.42,
      restingHR: 51,
      hrv: 84,
      sleepSecs: 27000,
      sleepQuality: 4,

      // Body composition
      bodyFat: 14.6,
      leanMass: 62.7,

      // Subjective
      soreness: 2,

      // VO2max
      vo2max: 56.4,

      // Trademark-banned wellness fields the typed shape excludes by name —
      // intervals.icu writes them on every wellness row. z.looseObject MUST
      // preserve them verbatim or the recovery-index cross-check loses signal.
      ctl: 52.1,
      atl: 38.4,
      ctlLoad: 51.9,
      atlLoad: 38.1,
      rampRate: 4.7,

      // Forward-compat — intervals.icu may add anything.
      mood: "good",
    };

    expect(WellnessDaySchema.parse(realisticWellness)).toEqual(realisticWellness);
  });
});

describe("WeeklyRollupSchema (z.looseObject)", () => {
  it("round-trips a typical weekly rollup with extra forward-compat fields", () => {
    const realisticWeek = {
      weekStartDate: "2026-04-13", // Monday
      weeklyLoad: 612,
      dailyLoads: [78, 142, 0, 95, 134, 88, 75],
      weeklyRecoveryHours: 14.5,

      // Forward-compat / extra signal callers may carry alongside.
      weeklyTimeSeconds: 28800,
      sourceSyncedAt: "2026-04-19T22:30:00Z",
    };

    expect(WeeklyRollupSchema.parse(realisticWeek)).toEqual(realisticWeek);
  });

  it("rejects a weekly rollup whose dailyLoads is not exactly length 7", () => {
    const malformed = {
      weekStartDate: "2026-04-13",
      weeklyLoad: 100,
      dailyLoads: [10, 20, 30, 40, 50, 60], // 6 entries
      weeklyRecoveryHours: 12,
    };

    expect(WeeklyRollupSchema.safeParse(malformed).success).toBe(false);
  });
});

describe("FtpHistoryPointSchema (z.looseObject)", () => {
  it("round-trips a test-source FTP history point with extra metadata", () => {
    const point = {
      date: "2026-03-22",
      ftp: 285,
      source: "test" as const,

      // Forward-compat — caller may carry test protocol metadata.
      protocol: "20min",
      testActivityId: 17654987,
    };

    expect(FtpHistoryPointSchema.parse(point)).toEqual(point);
  });

  it("rejects an FTP history point whose source is not 'test' or 'estimate'", () => {
    const malformed = {
      date: "2026-03-22",
      ftp: 285,
      source: "guess",
    };

    expect(FtpHistoryPointSchema.safeParse(malformed).success).toBe(false);
  });

  it("rejects an FTP history point whose ftp is non-positive or non-integer", () => {
    expect(
      FtpHistoryPointSchema.safeParse({ date: "2026-03-22", ftp: 0, source: "test" }).success,
    ).toBe(false);
    expect(
      FtpHistoryPointSchema.safeParse({ date: "2026-03-22", ftp: 285.5, source: "test" }).success,
    ).toBe(false);
  });
});

describe("PlannedEventSchema (z.looseObject)", () => {
  it("round-trips a calendar workout event with the optional name field", () => {
    const event = {
      id: 8899,
      category: "WORKOUT",
      start_date_local: "2026-04-15T07:30:00",
      name: "Sweet-spot 3x12",

      // Forward-compat — calendar entries may carry pairing hints, paths, etc.
      icu_paired_activity_id: 17654321,
      external_url: "https://intervals.icu/events/8899",
    };

    expect(PlannedEventSchema.parse(event)).toEqual(event);
  });

  it("round-trips a planned event without the optional name field", () => {
    const event = {
      id: 9001,
      category: "RACE",
      start_date_local: "2026-06-08T08:00:00",
    };

    expect(PlannedEventSchema.parse(event)).toEqual(event);
  });
});

describe("IcuIntervalRepSchema (z.looseObject)", () => {
  it("round-trips a WORK rep with extended per-rep telemetry", () => {
    const rep = {
      type: "WORK",
      duration: 1200,
      average_watts: 280,
      average_heartrate: 165,

      // Forward-compat — intervals.icu's per-rep field set is large.
      max_watts: 312,
      max_heartrate: 172,
      distance: 8400,
      elevation_gain: 42,
      pace: 285,
      cadence: 92,
    };

    expect(IcuIntervalRepSchema.parse(rep)).toEqual(rep);
  });

  it("accepts nullable + omitted optional power/HR fields (the 'no power meter' case)", () => {
    const ridelessRep = { type: "RECOVERY", duration: 300 };
    expect(IcuIntervalRepSchema.parse(ridelessRep)).toEqual(ridelessRep);

    const explicitNullRep = {
      type: "RECOVERY",
      duration: 300,
      average_watts: null,
      average_heartrate: null,
    };
    expect(IcuIntervalRepSchema.parse(explicitNullRep)).toEqual(explicitNullRep);
  });
});

describe("ZoneTimesSchema (z.looseObject)", () => {
  it("round-trips a 7-zone time-in-zone object plus extra forward-compat fields", () => {
    const zoneTimes = {
      z1: 600,
      z2: 1800,
      z3: 2400,
      z4: 540,
      z5: 60,
      z6: 0,
      z7: 0,

      // Forward-compat — intervals.icu may add z8 or aggregate keys.
      z8: 0,
      total: 5400,
    };

    expect(ZoneTimesSchema.parse(zoneTimes)).toEqual(zoneTimes);
  });

  it("accepts a partially-populated zone-times object (sparse rides)", () => {
    const partial = { z1: 1200, z2: 4200 };
    expect(ZoneTimesSchema.parse(partial)).toEqual(partial);
  });
});

describe("Normalized fitness/fatigue fields (anti-corruption layer per ADR-0012)", () => {
  it("WellnessDaySchema declares the 5 normalized fitness/fatigue fields", () => {
    const keys = Object.keys(WellnessDaySchema.shape);
    expect(keys).toContain("fitness");
    expect(keys).toContain("fatigue");
    expect(keys).toContain("fitnessContribution");
    expect(keys).toContain("fatigueContribution");
    expect(keys).toContain("weeklyFitnessChange");
  });

  it("ActivitySchema declares fitnessAtEnd and fatigueAtEnd", () => {
    const keys = Object.keys(ActivitySchema.shape);
    expect(keys).toContain("fitnessAtEnd");
    expect(keys).toContain("fatigueAtEnd");
  });

  it("the schemas declare a rename target for every TP API field", () => {
    // Cross-check: if a future contributor adds a TP API field to the rename
    // layer, the rename target MUST also land on the consuming schema.
    const wellnessRenameTargets = [
      "fitness",
      "fatigue",
      "fitnessContribution",
      "fatigueContribution",
      "weeklyFitnessChange",
    ];
    const activityRenameTargets = ["fitnessAtEnd", "fatigueAtEnd"];
    const wellnessKeys = Object.keys(WellnessDaySchema.shape);
    const activityKeys = Object.keys(ActivitySchema.shape);
    for (const target of wellnessRenameTargets) {
      expect(wellnessKeys).toContain(target);
    }
    for (const target of activityRenameTargets) {
      expect(activityKeys).toContain(target);
    }
  });

  it("round-trips an Activity with fitnessAtEnd and fatigueAtEnd", () => {
    const activity = {
      id: 17654321,
      start_date_local: "2026-04-15T07:30:00",
      type: "Ride",
      moving_time: 5400,
      elapsed_time: 5650,
      fitnessAtEnd: 52.1,
      fatigueAtEnd: 38.4,
    };
    expect(ActivitySchema.parse(activity)).toEqual(activity);
  });

  it("round-trips a WellnessDay with the 5 new normalized fields", () => {
    const day = {
      id: "2026-04-15",
      weight: 73.42,
      restingHR: 51,
      hrv: 84,
      sleepSecs: 27000,
      sleepQuality: 4,
      fitness: 52.1,
      fatigue: 38.4,
      fitnessContribution: 51.9,
      fatigueContribution: 38.1,
      weeklyFitnessChange: 4.7,
    };
    expect(WellnessDaySchema.parse(day)).toEqual(day);
  });

  it("accepts null for the new optional fields", () => {
    const dayWithNulls = {
      id: "2026-04-15",
      weight: null,
      restingHR: null,
      hrv: null,
      sleepSecs: null,
      sleepQuality: null,
      fitness: null,
      fatigue: null,
      fitnessContribution: null,
      fatigueContribution: null,
      weeklyFitnessChange: null,
    };
    expect(WellnessDaySchema.parse(dayWithNulls)).toEqual(dayWithNulls);

    const activityWithNulls = {
      id: 17654321,
      start_date_local: "2026-04-15T07:30:00",
      type: "Ride",
      moving_time: 5400,
      elapsed_time: 5650,
      fitnessAtEnd: null,
      fatigueAtEnd: null,
    };
    expect(ActivitySchema.parse(activityWithNulls)).toEqual(activityWithNulls);
  });

  it("accepts absent new optional fields", () => {
    const minimalDay = {
      id: "2026-04-15",
      weight: 73,
      restingHR: 51,
      hrv: 84,
      sleepSecs: 27000,
      sleepQuality: 4,
    };
    expect(WellnessDaySchema.parse(minimalDay)).toEqual(minimalDay);

    const minimalActivity = {
      id: 17654321,
      start_date_local: "2026-04-15T07:30:00",
      type: "Ride",
      moving_time: 5400,
      elapsed_time: 5650,
    };
    expect(ActivitySchema.parse(minimalActivity)).toEqual(minimalActivity);
  });
});
