import { describe, expect, it } from "vitest";

import {
  computeConsistencyDetails,
  computeConsistencyIndex,
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
