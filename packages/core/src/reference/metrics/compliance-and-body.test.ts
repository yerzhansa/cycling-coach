import { describe, expect, it } from "vitest";

import {
  calculateBenchmarkIndex,
  classifyEffortResponse,
  computeBenchmarkIndoor,
  computeBenchmarkOutdoor,
  computeConsistencyDetails,
  computeConsistencyIndex,
  computeEffortResponseSignal,
  computeHasIntervals,
  formatBenchmarkPercentage,
  isBenchmarkExpected,
} from "./compliance-and-body.js";
import type { MetricInput } from "./metric-input.js";

interface SyntheticActivity {
  start_date_local: string;
  type: string;
}

interface SyntheticEvent {
  category: string;
  start_date_local: string;
}

function input(
  activities: SyntheticActivity[],
  pastEvents: SyntheticEvent[],
  frozenNow = "2026-05-10T12:00:00",
): MetricInput {
  return {
    fixture: { activities, past_events: pastEvents },
    frozenNow,
  };
}

describe("computeConsistencyIndex / computeConsistencyDetails", () => {
  it("returns the empty-planned shape when past_events is absent (the golden-fixture branch)", () => {
    // No `past_events` key at all → accessor returns []. Cycling activities
    // still feed completed_days; non-cycling rides drop out per sync.py:3553.
    const env: MetricInput = {
      fixture: {
        activities: [
          { start_date_local: "2026-05-08T07:00:00", type: "Ride" },
          { start_date_local: "2026-05-09T07:00:00", type: "Run" },
          { start_date_local: "2026-05-10T07:00:00", type: "VirtualRide" },
        ],
      },
      frozenNow: "2026-05-10T12:00:00",
    };

    expect(computeConsistencyIndex(env)).toBeNull();
    expect(computeConsistencyDetails(env)).toEqual({
      planned_days: 0,
      completed_days: 2,
      matched_days: 0,
      note: "No planned workouts in period",
    });
  });

  it("excludes cycling activities outside the trailing 7-day window from completed_days", () => {
    // The snapshot harness pre-slices to activities_7d, mirroring the
    // upstream caller at `sync.py:2561`. With a frozenNow of 2026-05-10 the
    // window is [2026-05-04, 2026-05-10]; a 2026-05-01 ride falls out while
    // 05-04 and 05-10 stay in.
    const env: MetricInput = {
      fixture: {
        activities: [
          { start_date_local: "2026-05-01T07:00:00", type: "Ride" },
          { start_date_local: "2026-05-04T07:00:00", type: "Ride" },
          { start_date_local: "2026-05-10T07:00:00", type: "Ride" },
        ],
      },
      frozenNow: "2026-05-10T12:00:00",
    };
    expect(computeConsistencyDetails(env)).toMatchObject({
      completed_days: 2,
    });
  });

  it("excludes non-cycling sport types from completed_dates even when other sports were the planned discipline", () => {
    // Multi-sport athlete: two cycling rides + a run + a swim on the same
    // planned dates. Only the two cycling days count as "completed", so a
    // planned date with only a run/swim never matches.
    const env = input(
      [
        { start_date_local: "2026-05-05T07:00:00", type: "Ride" },
        { start_date_local: "2026-05-06T07:00:00", type: "Run" },
        { start_date_local: "2026-05-07T07:00:00", type: "Swim" },
        { start_date_local: "2026-05-08T07:00:00", type: "MountainBikeRide" },
      ],
      [
        { category: "WORKOUT", start_date_local: "2026-05-05T06:00:00" },
        { category: "WORKOUT", start_date_local: "2026-05-06T06:00:00" },
        { category: "WORKOUT", start_date_local: "2026-05-07T06:00:00" },
        { category: "WORKOUT", start_date_local: "2026-05-08T06:00:00" },
      ],
    );

    expect(computeConsistencyIndex(env)).toBe(0.5);
    expect(computeConsistencyDetails(env)).toEqual({
      planned_days: 4,
      completed_days: 2,
      matched_days: 2,
      planned_dates: [
        "2026-05-05",
        "2026-05-06",
        "2026-05-07",
        "2026-05-08",
      ],
      completed_dates: ["2026-05-05", "2026-05-08"],
    });
  });

  it("filters out non-WORKOUT past_events (RACE, NOTE, etc.) from the planned set", () => {
    // sync.py:3546 gates on `category == "WORKOUT"`. RACE events on planned
    // days don't count even if there's a matching ride.
    const env = input(
      [{ start_date_local: "2026-05-09T07:00:00", type: "Ride" }],
      [
        { category: "RACE", start_date_local: "2026-05-09T06:00:00" },
        { category: "NOTE", start_date_local: "2026-05-10T06:00:00" },
      ],
    );

    expect(computeConsistencyIndex(env)).toBeNull();
    expect(computeConsistencyDetails(env)).toEqual({
      planned_days: 0,
      completed_days: 1,
      matched_days: 0,
      note: "No planned workouts in period",
    });
  });

  it("de-duplicates planned and completed dates by calendar day", () => {
    // Two workouts planned on 2026-05-05 plus one on 2026-05-06; three
    // cycling rides on 2026-05-05 (one of them VirtualRide). 2/2 match.
    const env = input(
      [
        { start_date_local: "2026-05-05T07:00:00", type: "Ride" },
        { start_date_local: "2026-05-05T17:00:00", type: "VirtualRide" },
        { start_date_local: "2026-05-05T20:00:00", type: "GravelRide" },
        { start_date_local: "2026-05-06T08:00:00", type: "Ride" },
      ],
      [
        { category: "WORKOUT", start_date_local: "2026-05-05T06:00:00" },
        { category: "WORKOUT", start_date_local: "2026-05-05T18:00:00" },
        { category: "WORKOUT", start_date_local: "2026-05-06T06:00:00" },
      ],
    );

    expect(computeConsistencyIndex(env)).toBe(1.0);
    expect(computeConsistencyDetails(env)).toEqual({
      planned_days: 2,
      completed_days: 2,
      matched_days: 2,
      planned_dates: ["2026-05-05", "2026-05-06"],
      completed_dates: ["2026-05-05", "2026-05-06"],
    });
  });

  it("rounds half-to-even at a 2-dp boundary (1/3 → 0.33, not 0.333…)", () => {
    // 1 matched out of 3 planned = 0.3333… → roundHalfEven to 2 dp = 0.33.
    const env = input(
      [{ start_date_local: "2026-05-07T07:00:00", type: "Ride" }],
      [
        { category: "WORKOUT", start_date_local: "2026-05-05T06:00:00" },
        { category: "WORKOUT", start_date_local: "2026-05-07T06:00:00" },
        { category: "WORKOUT", start_date_local: "2026-05-09T06:00:00" },
      ],
    );

    expect(computeConsistencyIndex(env)).toBe(0.33);
    expect(computeConsistencyDetails(env)).toMatchObject({
      planned_days: 3,
      completed_days: 1,
      matched_days: 1,
    });
  });

  it("sorts planned_dates and completed_dates ascending regardless of insertion order", () => {
    const env = input(
      [
        { start_date_local: "2026-05-09T07:00:00", type: "Ride" },
        { start_date_local: "2026-05-04T07:00:00", type: "Ride" },
        { start_date_local: "2026-05-06T07:00:00", type: "Ride" },
      ],
      [
        { category: "WORKOUT", start_date_local: "2026-05-09T06:00:00" },
        { category: "WORKOUT", start_date_local: "2026-05-04T06:00:00" },
        { category: "WORKOUT", start_date_local: "2026-05-06T06:00:00" },
      ],
    );

    const details = computeConsistencyDetails(env);
    if ("planned_dates" in details) {
      expect(details.planned_dates).toEqual([
        "2026-05-04",
        "2026-05-06",
        "2026-05-09",
      ]);
      expect(details.completed_dates).toEqual([
        "2026-05-04",
        "2026-05-06",
        "2026-05-09",
      ]);
    } else {
      throw new Error("expected populated branch");
    }
  });

  it("emits the empty-planned shape without date lists, populated shape without `note`", () => {
    // The two shapes are mutually exclusive — `note` lives only on the
    // empty-planned branch; `planned_dates`/`completed_dates` only on the
    // populated branch. Bit-identical parity depends on this distinction.
    const empty = computeConsistencyDetails(input([], []));
    expect(empty).toHaveProperty("note");
    expect(empty).not.toHaveProperty("planned_dates");
    expect(empty).not.toHaveProperty("completed_dates");

    const populated = computeConsistencyDetails(
      input(
        [{ start_date_local: "2026-05-05T07:00:00", type: "Ride" }],
        [{ category: "WORKOUT", start_date_local: "2026-05-05T06:00:00" }],
      ),
    );
    expect(populated).not.toHaveProperty("note");
    expect(populated).toHaveProperty("planned_dates");
    expect(populated).toHaveProperty("completed_dates");
  });
});

function benchmarkInput(
  overrides: {
    currentFtpIndoor?: number | null;
    ftpHistoryIndoor?: Record<string, number>;
    frozenNow?: string;
  } = {},
): MetricInput {
  return {
    fixture: {
      current_ftp_indoor: overrides.currentFtpIndoor ?? null,
      ftp_history_indoor: overrides.ftpHistoryIndoor ?? {},
    },
    frozenNow: overrides.frozenNow ?? "2026-05-10T12:00:00",
  };
}

describe("calculateBenchmarkIndex", () => {
  it("returns (null, null) when current FTP is falsy (the golden-fixture branch)", () => {
    expect(calculateBenchmarkIndex(null, { "2026-03-15": 250 }, "2026-05-10T12:00:00"))
      .toEqual({ benchmarkIndex: null, ftp8WeeksAgo: null });
    expect(calculateBenchmarkIndex(0, { "2026-03-15": 250 }, "2026-05-10T12:00:00"))
      .toEqual({ benchmarkIndex: null, ftp8WeeksAgo: null });
  });

  it("returns (null, null) when ftp_history is empty", () => {
    expect(calculateBenchmarkIndex(280, {}, "2026-05-10T12:00:00"))
      .toEqual({ benchmarkIndex: null, ftp8WeeksAgo: null });
  });

  it("returns (null, null) when no entry falls inside the ±7d window around (today - 56d)", () => {
    // frozenNow 2026-05-10T12:00:00 → target 2026-03-15T12:00:00, window
    // [2026-03-08T12:00:00, 2026-03-22T12:00:00]. Entries at 03-08 midnight
    // (just before earliest) and 03-23 midnight (after latest) both drop.
    const result = calculateBenchmarkIndex(
      280,
      { "2026-03-08": 270, "2026-03-23": 272 },
      "2026-05-10T12:00:00",
    );
    expect(result).toEqual({ benchmarkIndex: null, ftp8WeeksAgo: null });
  });

  it("rounds the change ratio half-to-even to 3 dp (sync.py:2234)", () => {
    // 280 / 250 - 1 = 0.12 exactly. Round to 3 dp → 0.12.
    expect(
      calculateBenchmarkIndex(280, { "2026-03-15": 250 }, "2026-05-10T12:00:00"),
    ).toEqual({ benchmarkIndex: 0.12, ftp8WeeksAgo: 250 });
    // 262 / 280 - 1 = -0.064285… → round to 3 dp = -0.064.
    expect(
      calculateBenchmarkIndex(262, { "2026-03-15": 280 }, "2026-05-10T12:00:00"),
    ).toEqual({ benchmarkIndex: -0.064, ftp8WeeksAgo: 280 });
  });

  it("picks the entry with the smallest |date - target| in days (Python timedelta.days semantics)", () => {
    // Target 2026-03-15T12:00:00. Per Python's `timedelta.days` floor
    // semantics: 03-13 has diff 3, 03-15 has diff 1 (-12h floors to -1d),
    // 03-16 has diff 0 (+12h floors to 0d), 03-17 has diff 1 (+1.5d floors
    // to 1d). 03-16 is the unique minimum.
    const result = calculateBenchmarkIndex(
      300,
      {
        "2026-03-13": 240,
        "2026-03-15": 250,
        "2026-03-16": 260,
        "2026-03-17": 270,
      },
      "2026-05-10T12:00:00",
    );
    expect(result.ftp8WeeksAgo).toBe(260);
  });

  it("first-encountered entry wins on a true |diff| tie (strict `<` doesn't replace on equality)", () => {
    // Target 2026-03-15T12:00:00. Both 03-09 and 03-21 sit ~6.5 days from
    // the target so their `timedelta.days` magnitudes are 7 each (03-09 is
    // -6.5d → floor → -7d → abs 7; 03-21 is +5.5d → floor → 5d → abs 5).
    // Hmm — those aren't equal. Use 03-08T12 vs 03-22T12 instead: 03-08
    // midnight is -7.5d → floor → -8d → abs 8 (outside window), so pick
    // two entries with literal equal diffs: 03-14 (-1.5d → -2d → 2) and
    // 03-17 (+1.5d → 1d → 1). Still not equal. The only real tie in
    // integer-day land comes from symmetric entries around an integer-day
    // target — which only happens with a midnight frozenNow. Test that
    // case explicitly.
    const result = calculateBenchmarkIndex(
      300,
      { "2026-03-14": 240, "2026-03-16": 260 },
      "2026-05-10T00:00:00",
    );
    // Target 2026-03-15T00:00:00. 03-14 diff = -1d → abs 1; 03-16 diff =
    // +1d → abs 1. 03-14 was inserted first and the strict `<` doesn't
    // displace it.
    expect(result.ftp8WeeksAgo).toBe(240);
  });

  it("skips malformed date keys without crashing (sync.py:2229 try/except)", () => {
    const result = calculateBenchmarkIndex(
      280,
      {
        "not-a-date": 999,
        "2026-13-01": 998, // bad month
        "2026-03-15": 250,
      },
      "2026-05-10T12:00:00",
    );
    expect(result).toEqual({ benchmarkIndex: 0.12, ftp8WeeksAgo: 250 });
  });

  it("rejects calendar-invalid dates that JS Date.UTC would silently normalise (Feb 30 etc.)", () => {
    // Date.UTC(2026, 1, 30) rolls to 2026-03-02 — without a round-trip check
    // the entry would slip into the ±7d window around the 2026-03-01 target
    // (frozenNow 2026-04-26) and bind ftp_8_weeks_ago to 999. Python's
    // strptime raises ValueError and the except clause skips, so the only
    // surviving entry must be the calendar-real 2026-03-04 one.
    const result = calculateBenchmarkIndex(
      280,
      {
        "2026-02-30": 999, // not a real date
        "2026-04-31": 998, // not a real date
        "2026-03-04": 250,
      },
      "2026-04-26T12:00:00",
    );
    expect(result).toEqual({ benchmarkIndex: 0.12, ftp8WeeksAgo: 250 });
  });
});

describe("isBenchmarkExpected", () => {
  it("returns null when the benchmark index is null", () => {
    expect(isBenchmarkExpected(null, "Build / Early Race Season")).toBeNull();
  });

  it("returns null for the defensive Unknown phase", () => {
    expect(isBenchmarkExpected(0.03, "Unknown")).toBeNull();
  });

  it("matches the per-phase expectations table at the inclusive endpoints", () => {
    // Build / Early Race Season: [0.01, 0.04]
    expect(isBenchmarkExpected(0.01, "Build / Early Race Season")).toBe(true);
    expect(isBenchmarkExpected(0.04, "Build / Early Race Season")).toBe(true);
    expect(isBenchmarkExpected(0.005, "Build / Early Race Season")).toBe(false);
    expect(isBenchmarkExpected(0.041, "Build / Early Race Season")).toBe(false);
    // Off-season / Transition: [-0.05, -0.02] (both endpoints negative)
    expect(isBenchmarkExpected(-0.05, "Off-season / Transition")).toBe(true);
    expect(isBenchmarkExpected(-0.02, "Off-season / Transition")).toBe(true);
    expect(isBenchmarkExpected(-0.06, "Off-season / Transition")).toBe(false);
    // Late Season / Transition: [-0.03, 0.00] (zero is the upper bound)
    expect(isBenchmarkExpected(0.0, "Late Season / Transition")).toBe(true);
    expect(isBenchmarkExpected(0.001, "Late Season / Transition")).toBe(false);
  });
});

describe("formatBenchmarkPercentage", () => {
  it("matches Python's f-string ':+.1%' for typical magnitudes", () => {
    expect(formatBenchmarkPercentage(0.05)).toBe("+5.0%");
    expect(formatBenchmarkPercentage(-0.023)).toBe("-2.3%");
    expect(formatBenchmarkPercentage(0.001)).toBe("+0.1%");
    expect(formatBenchmarkPercentage(0)).toBe("+0.0%");
  });

  it("preserves negative-zero with the '-' sign (Python's :+.1% distinguishes)", () => {
    expect(formatBenchmarkPercentage(-0)).toBe("-0.0%");
  });
});

describe("computeBenchmarkIndoor", () => {
  it("emits the all-null 5-key dict when current_ftp_indoor + ftp_history_indoor are absent (the golden-fixture branch)", () => {
    // Mirrors what every current snapshot looks like: harness passes
    // (None, None, None) into _calculate_derived_metrics, so all 5 keys
    // collapse to null. Seasonal context never affects this branch — it's
    // gated upstream by the null benchmark_index.
    const env: MetricInput = {
      fixture: {},
      frozenNow: "2026-05-10T12:00:00",
    };
    expect(computeBenchmarkIndoor(env)).toEqual({
      current_ftp: null,
      ftp_8_weeks_ago: null,
      benchmark_index: null,
      benchmark_percentage: null,
      seasonal_expected: null,
    });
  });

  it("emits the full 5-key populated dict when a match exists in the ±7d window", () => {
    // frozenNow 2026-05-10 → May → Build / Early Race Season → [0.01, 0.04].
    // 300 / 270 - 1 = 0.111… → round 3 dp = 0.111 → above 0.04 → expected
    // false. benchmark_percentage = (0.111 * 100).toFixed(1) = '+11.1%'.
    const env = benchmarkInput({
      currentFtpIndoor: 300,
      ftpHistoryIndoor: { "2026-03-15": 270 },
    });
    expect(computeBenchmarkIndoor(env)).toEqual({
      current_ftp: 300,
      ftp_8_weeks_ago: 270,
      benchmark_index: 0.111,
      benchmark_percentage: "+11.1%",
      seasonal_expected: false,
    });
  });

  it("returns seasonal_expected=true when the index sits inside the per-phase range", () => {
    // 280 / 275 - 1 = 0.01818… → round 3 dp = 0.018. In Build window [0.01, 0.04].
    const env = benchmarkInput({
      currentFtpIndoor: 280,
      ftpHistoryIndoor: { "2026-03-15": 275 },
    });
    expect(computeBenchmarkIndoor(env)).toEqual({
      current_ftp: 280,
      ftp_8_weeks_ago: 275,
      benchmark_index: 0.018,
      benchmark_percentage: "+1.8%",
      seasonal_expected: true,
    });
  });

  it("sources `today` from input.frozenNow, NOT the wall clock", () => {
    // Pin frozenNow to a December date — that lands in "Off-season / Transition"
    // with range [-0.05, -0.02]. The wall-clock month would be a different
    // season, flipping seasonal_expected. Target = 2026-12-10 - 56d ≈ 2026-10-15
    // so a history entry on 2026-10-15 sits at the target.
    const env = benchmarkInput({
      currentFtpIndoor: 270,
      ftpHistoryIndoor: { "2026-10-15": 280 },
      frozenNow: "2026-12-10T12:00:00",
    });
    const result = computeBenchmarkIndoor(env);
    // 270 / 280 - 1 = -0.035714… → -0.036. Inside [-0.05, -0.02] → true.
    expect(result.benchmark_index).toBe(-0.036);
    expect(result.seasonal_expected).toBe(true);
  });
});

function benchmarkOutdoorInput(
  overrides: {
    currentFtpOutdoor?: number | null;
    ftpHistoryOutdoor?: Record<string, number>;
    frozenNow?: string;
  } = {},
): MetricInput {
  return {
    fixture: {
      current_ftp_outdoor: overrides.currentFtpOutdoor ?? null,
      ftp_history_outdoor: overrides.ftpHistoryOutdoor ?? {},
    },
    frozenNow: overrides.frozenNow ?? "2026-05-10T12:00:00",
  };
}

describe("computeBenchmarkOutdoor", () => {
  it("emits the all-null 5-key dict when current_ftp_outdoor + ftp_history_outdoor are absent (the golden-fixture branch)", () => {
    // Every current snapshot lands here: the harness passes
    // (None, None, None) into _calculate_derived_metrics for both indoor
    // and outdoor, so the emission dict collapses to all-null on the
    // outdoor branch too.
    const env: MetricInput = {
      fixture: {},
      frozenNow: "2026-05-10T12:00:00",
    };
    expect(computeBenchmarkOutdoor(env)).toEqual({
      current_ftp: null,
      ftp_8_weeks_ago: null,
      benchmark_index: null,
      benchmark_percentage: null,
      seasonal_expected: null,
    });
  });

  it("emits the full 5-key populated dict when a match exists in the ±7d window", () => {
    // frozenNow 2026-05-10 → May → Build / Early Race Season → [0.01, 0.04].
    // 320 / 290 - 1 = 0.10344… → round 3 dp = 0.103 → above 0.04 → expected
    // false. benchmark_percentage = (0.103 * 100).toFixed(1) = '+10.3%'.
    const env = benchmarkOutdoorInput({
      currentFtpOutdoor: 320,
      ftpHistoryOutdoor: { "2026-03-15": 290 },
    });
    expect(computeBenchmarkOutdoor(env)).toEqual({
      current_ftp: 320,
      ftp_8_weeks_ago: 290,
      benchmark_index: 0.103,
      benchmark_percentage: "+10.3%",
      seasonal_expected: false,
    });
  });

  it("uses the outdoor accessors — does NOT cross-read the indoor fixture keys", () => {
    // Mixed fixture: indoor keys are present (and would yield a populated
    // dict on the indoor branch) but outdoor keys are absent. The outdoor
    // branch must still collapse to all-null — proves the accessor split.
    const env: MetricInput = {
      fixture: {
        current_ftp_indoor: 300,
        ftp_history_indoor: { "2026-03-15": 270 },
      },
      frozenNow: "2026-05-10T12:00:00",
    };
    expect(computeBenchmarkOutdoor(env)).toEqual({
      current_ftp: null,
      ftp_8_weeks_ago: null,
      benchmark_index: null,
      benchmark_percentage: null,
      seasonal_expected: null,
    });
  });

  it("returns seasonal_expected=true when the index sits inside the per-phase range", () => {
    // 285 / 280 - 1 = 0.017857… → round 3 dp = 0.018. In Build [0.01, 0.04].
    const env = benchmarkOutdoorInput({
      currentFtpOutdoor: 285,
      ftpHistoryOutdoor: { "2026-03-15": 280 },
    });
    expect(computeBenchmarkOutdoor(env)).toEqual({
      current_ftp: 285,
      ftp_8_weeks_ago: 280,
      benchmark_index: 0.018,
      benchmark_percentage: "+1.8%",
      seasonal_expected: true,
    });
  });
});

describe("computeHasIntervals", () => {
  // The v3.106 fix narrows the predicate to WORK segments only — a non-empty
  // intervals list is no longer sufficient. The five branches at
  // `sync.py:7866-7873` are exercised here at unit scope; the populated
  // fixture exercises the same five at the parity gate.
  interface IntervalEntry {
    intervals?: { type: string }[];
    [k: string]: unknown;
  }

  function withIntervals(
    activities: { id: string | number }[],
    intervals: Record<string, IntervalEntry>,
  ): MetricInput {
    return {
      fixture: {
        activities: activities.map((a) => ({
          id: a.id,
          start_date_local: "2026-05-10T07:00:00",
          type: "Ride",
          moving_time: 1800,
          elapsed_time: 1900,
        })),
        intervals,
      } as MetricInput["fixture"],
      frozenNow: "2026-05-10T12:00:00",
    };
  }

  it("flags an activity true when its lookup entry has a WORK segment (branch a)", () => {
    const env = withIntervals(
      [{ id: "a1" }],
      { a1: { intervals: [{ type: "WORK" }] } },
    );
    expect(computeHasIntervals(env)).toEqual({ a1: true });
  });

  it("flags an activity false when its lookup entry has only RECOVERY segments (branch b, v3.106 regression test)", () => {
    // Pre-v3.106 this returned true (non-empty intervals list). The fix at
    // sync.py:133 narrowed the predicate; whole-session RECOVERY placeholders
    // on unstructured endurance rides now classify as false.
    const env = withIntervals(
      [{ id: "a2" }],
      { a2: { intervals: [{ type: "RECOVERY" }] } },
    );
    expect(computeHasIntervals(env)).toEqual({ a2: false });
  });

  it("flags an activity false when its lookup entry has an empty intervals list (branch c)", () => {
    const env = withIntervals(
      [{ id: "a3" }],
      { a3: { intervals: [] } },
    );
    expect(computeHasIntervals(env)).toEqual({ a3: false });
  });

  it("flags an activity false when it is NOT in the intervals lookup (branch d, default)", () => {
    // No entry for a4 in the lookup. Upstream's `intervals_by_id.get(id)`
    // returns None; the `if _entry:` gate short-circuits.
    const env = withIntervals([{ id: "a4" }], {});
    expect(computeHasIntervals(env)).toEqual({ a4: false });
  });

  it("flags an activity false when its lookup entry is missing the intervals key (branch e, `or []` short-circuit)", () => {
    // Mirrors sync.py:7872 — `(_entry.get("intervals") or [])` coerces a
    // missing or falsy `intervals` to an empty iterable; the WORK check
    // then has nothing to match.
    const env = withIntervals(
      [{ id: "a5" }],
      { a5: { dfa: { quality: { sufficient: false } } } },
    );
    expect(computeHasIntervals(env)).toEqual({ a5: false });
  });

  it("returns an empty map when there are no activities", () => {
    const env = withIntervals([], {});
    expect(computeHasIntervals(env)).toEqual({});
  });

  it("stringifies numeric activity ids for the lookup (mirrors `str(act.get('id'))` at sync.py:7870)", () => {
    // Real intervals.icu activity ids round-trip as numbers on some endpoints.
    // The upstream's lookup key is `str(activity_id)`, so the TS port must
    // stringify too.
    const env = withIntervals(
      [{ id: 12345 }],
      { "12345": { intervals: [{ type: "WORK" }] } },
    );
    expect(computeHasIntervals(env)).toEqual({ "12345": true });
  });

  it("emits the per-activity map with keys sorted ascending as strings", () => {
    // The harness sorts via `sorted(d.keys())` before emit. The TS port also
    // sorts so call-site iteration order is locked across Pyodide / CPython /
    // Node. Non-integer-like keys are used here because V8 / SpiderMonkey
    // / JSC iterate integer-like string keys ('1','2','10') in numeric
    // ascending order regardless of insertion order — a quirk of the
    // ECMAScript Object key-ordering spec that masks insertion-order bugs
    // on numeric-id activities (the parity gate's deepCompare is order-
    // insensitive, so this matters for downstream LLM iteration only).
    // Real intervals.icu ids carry the 'i' prefix (e.g. 'i146622609'),
    // which stays non-integer-like.
    const env = withIntervals(
      [{ id: "i20" }, { id: "i03" }, { id: "i10" }],
      {
        i20: { intervals: [{ type: "WORK" }] },
        i03: { intervals: [{ type: "WORK" }] },
        i10: { intervals: [{ type: "RECOVERY" }] },
      },
    );
    expect(Object.keys(computeHasIntervals(env))).toEqual([
      "i03",
      "i10",
      "i20",
    ]);
  });

  it("returns true when any segment is WORK (mixed list with RECOVERY + WORK)", () => {
    // Defends against an over-narrow predicate that requires ALL segments
    // to be WORK. Upstream uses `any(...)` semantics.
    const env = withIntervals(
      [{ id: "mix" }],
      {
        mix: {
          intervals: [
            { type: "RECOVERY" },
            { type: "WORK" },
            { type: "RECOVERY" },
          ],
        },
      },
    );
    expect(computeHasIntervals(env)).toEqual({ mix: true });
  });

  it("treats a missing intervals top-level key as an empty lookup (FixtureSchema .optional() compatibility)", () => {
    // ADR-0017: existing fixtures without an `intervals` top-level key
    // must still classify cleanly; every activity falls into branch (d).
    const env: MetricInput = {
      fixture: {
        activities: [
          {
            id: "a1",
            start_date_local: "2026-05-10T07:00:00",
            type: "Ride",
            moving_time: 1800,
            elapsed_time: 1900,
          },
        ],
      } as MetricInput["fixture"],
      frozenNow: "2026-05-10T12:00:00",
    };
    expect(computeHasIntervals(env)).toEqual({ a1: false });
  });
});

describe("classifyEffortResponse", () => {
  // The 6 bands × 3 outcomes matrix below covers every rpe vs band-edge
  // verdict the upstream returns. Each table row is (intensityPct, rpe,
  // expected) with a comment naming the band it targets. The first 3 rows
  // cover the Intensity<0.65 None branch (band 1, all-None). The remaining 15
  // cover the 5 verdict-producing bands (bands 2-6) × {positive, neutral,
  // negative}.
  type Verdict = ReturnType<typeof classifyEffortResponse>;

  const matrix: Array<[number, number, Verdict, string]> = [
    // Band 1: if_decimal < 0.65 → null (deliberate design gap)
    [60, 2, null, "if_decimal=0.60 (band 1) — rpe low, still null"],
    [60, 5, null, "if_decimal=0.60 (band 1) — rpe mid, still null"],
    [60, 8, null, "if_decimal=0.60 (band 1) — rpe high, still null"],
    // Band 2: 0.65 ≤ if_decimal < 0.75 → [2, 4]
    [70, 1, "positive", "if_decimal=0.70 (band 2) — rpe=1 < 2 → positive"],
    [70, 3, "neutral", "if_decimal=0.70 (band 2) — rpe=3 in [2,4] → neutral"],
    [70, 5, "negative", "if_decimal=0.70 (band 2) — rpe=5 > 4 → negative"],
    // Band 3: 0.75 ≤ if_decimal < 0.85 → [4, 6]
    [80, 3, "positive", "if_decimal=0.80 (band 3) — rpe=3 < 4 → positive"],
    [80, 5, "neutral", "if_decimal=0.80 (band 3) — rpe=5 in [4,6] → neutral"],
    [80, 7, "negative", "if_decimal=0.80 (band 3) — rpe=7 > 6 → negative"],
    // Band 4: 0.85 ≤ if_decimal < 0.95 → [6, 8]
    [90, 5, "positive", "if_decimal=0.90 (band 4) — rpe=5 < 6 → positive"],
    [90, 7, "neutral", "if_decimal=0.90 (band 4) — rpe=7 in [6,8] → neutral"],
    [90, 9, "negative", "if_decimal=0.90 (band 4) — rpe=9 > 8 → negative"],
    // Band 5: 0.95 ≤ if_decimal < 1.05 → [8, 9]
    [100, 7, "positive", "if_decimal=1.00 (band 5) — rpe=7 < 8 → positive"],
    [100, 8.5, "neutral", "if_decimal=1.00 (band 5) — rpe=8.5 in [8,9] → neutral"],
    [100, 10, "negative", "if_decimal=1.00 (band 5) — rpe=10 > 9 → negative"],
    // Band 6: if_decimal ≥ 1.05 → [9, 10]
    [110, 8, "positive", "if_decimal=1.10 (band 6) — rpe=8 < 9 → positive"],
    [110, 9.5, "neutral", "if_decimal=1.10 (band 6) — rpe=9.5 in [9,10] → neutral"],
    [110, 10.1, "negative", "if_decimal=1.10 (band 6) — rpe=10.1 > 10 → negative"],
  ];

  for (const [intensityPct, rpe, expected, label] of matrix) {
    it(label, () => {
      expect(classifyEffortResponse(intensityPct, rpe)).toBe(expected);
    });
  }

  it("returns null when intensityPct is null (sync.py:3515 if_value is None)", () => {
    expect(classifyEffortResponse(null, 5)).toBeNull();
  });

  it("returns null when intensityPct is undefined", () => {
    expect(classifyEffortResponse(undefined, 5)).toBeNull();
  });

  it("returns null when rpe is null (sync.py:3515 rpe is None)", () => {
    expect(classifyEffortResponse(80, null)).toBeNull();
  });

  it("returns null when rpe is undefined", () => {
    expect(classifyEffortResponse(80, undefined)).toBeNull();
  });

  it("returns null when rpe is 0 (sync.py:3515 rpe <= 0)", () => {
    // rpe=0 is treated as 'unset' rather than 'easiest possible' — the
    // upstream's <=0 gate captures the intervals.icu placeholder some
    // unscored activities ship.
    expect(classifyEffortResponse(80, 0)).toBeNull();
  });

  it("returns null when rpe is negative (sync.py:3515 rpe <= 0)", () => {
    expect(classifyEffortResponse(80, -1)).toBeNull();
  });

  it("uses band 2 (not band 1) exactly at if_decimal = 0.65 (lower edge inclusive)", () => {
    // The `< 0.65` gate excludes only strictly-less; 0.65 enters band 2 [2,4].
    expect(classifyEffortResponse(65, 3)).toBe("neutral");
  });

  it("uses band 3 (not band 2) exactly at if_decimal = 0.75 (band 2 upper exclusive)", () => {
    // `if if_decimal < 0.75` is exclusive on 0.75; the value falls through to
    // band 3 [4,6]. rpe=3 is < 4 → positive.
    expect(classifyEffortResponse(75, 3)).toBe("positive");
  });

  it("uses band 6 (not band 5) exactly at if_decimal = 1.05 (band 5 upper exclusive)", () => {
    // `if if_decimal < 1.05` is exclusive on 1.05; the value enters band 6
    // [9,10]. rpe=9 in [9,10] → neutral.
    expect(classifyEffortResponse(105, 9)).toBe("neutral");
  });
});

describe("computeEffortResponseSignal", () => {
  function withActivities(
    rows: { id: string | number; icu_intensity?: number; icu_rpe?: number }[],
  ): MetricInput {
    return {
      fixture: {
        activities: rows.map((r) => ({
          id: r.id,
          start_date_local: "2026-05-10T07:00:00",
          type: "Ride",
          moving_time: 1800,
          elapsed_time: 1900,
          ...(r.icu_intensity !== undefined
            ? { icu_intensity: r.icu_intensity }
            : {}),
          ...(r.icu_rpe !== undefined ? { icu_rpe: r.icu_rpe } : {}),
        })),
      } as MetricInput["fixture"],
      frozenNow: "2026-05-10T12:00:00",
    };
  }

  it("emits null for an activity missing both icu_intensity and icu_rpe (golden-fixture branch)", () => {
    // Every golden fixture today omits icu_rpe — the verdict for every
    // activity collapses to null. This is the parity-snapshot reality.
    const env = withActivities([{ id: "a1" }]);
    expect(computeEffortResponseSignal(env)).toEqual({ a1: null });
  });

  it("emits null for an activity that has icu_intensity but no icu_rpe", () => {
    const env = withActivities([{ id: "a1", icu_intensity: 80 }]);
    expect(computeEffortResponseSignal(env)).toEqual({ a1: null });
  });

  it("emits the verdict when both fields are present (read-through smoke test)", () => {
    const env = withActivities([
      { id: "a1", icu_intensity: 80, icu_rpe: 5 },
    ]);
    expect(computeEffortResponseSignal(env)).toEqual({ a1: "neutral" });
  });

  it("returns an empty map when there are no activities", () => {
    const env = withActivities([]);
    expect(computeEffortResponseSignal(env)).toEqual({});
  });

  it("stringifies numeric activity ids (mirrors str(act.get('id')) at sync.py:7870)", () => {
    const env = withActivities([
      { id: 12345, icu_intensity: 70, icu_rpe: 3 },
    ]);
    expect(computeEffortResponseSignal(env)).toEqual({ "12345": "neutral" });
  });

  it("emits the per-activity map with keys sorted ascending as strings", () => {
    // Non-integer-like keys defeat V8's numeric key-ordering quirk so
    // insertion-order bugs are visible. Mirrors the has_intervals sort
    // discipline landed alongside the per-activity snapshot pattern.
    const env = withActivities([
      { id: "i20", icu_intensity: 80, icu_rpe: 5 },
      { id: "i03", icu_intensity: 80, icu_rpe: 5 },
      { id: "i10", icu_intensity: 80, icu_rpe: 5 },
    ]);
    expect(Object.keys(computeEffortResponseSignal(env))).toEqual([
      "i03",
      "i10",
      "i20",
    ]);
  });
});
