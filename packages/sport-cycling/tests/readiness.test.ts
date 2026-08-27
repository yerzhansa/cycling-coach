import { describe, expect, it } from "vitest";
import { cyclingTaperRefusal, projectCyclingReadinessInput } from "../src/readiness.js";

const estimatedCp = {
  status: "unavailable" as const,
  watts: null,
  calculatedOn: null,
  lastSuccessfulSyncAtMs: null,
  unavailableReason: "missing-effort" as const,
  efforts: [] as [],
};

describe("cycling readiness inputs", () => {
  it("normalizes the latest platform seed and explicit future Load ranges", () => {
    expect(
      projectCyclingReadinessInput({
        today: "2026-08-22",
        raceDate: "2026-08-24",
        wellness: [
          { id: "2026-08-21", fitness: 59, fatigue: 60 },
          { id: "2026-08-22", fitness: 60, fatigue: 59 },
        ],
        currentStatus: {
          readiness: {
            supportedDistanceKm: { min: 135, max: 145 },
            fatigue: "normal",
            missedKeyWorkouts: 0,
            courseEstimate: {
              status: "available",
              rangeMinutes: { min: 288, max: 312 },
              confidence: "moderate",
              assumptions: ["Dry roads"],
            },
          },
        },
        estimatedCp,
        lastSuccessfulRefreshAtMs: 1_777_000_000_000,
        workouts: [
          {
            date: "2026-08-24",
            name: "Race",
            durationS: 18_000,
            structureJson: JSON.stringify({ trainingLoadRange: { min: 20, max: 30 } }),
          },
        ],
      }),
    ).toMatchObject({
      platformSeed: { asOf: "2026-08-22", fitness: 60, fatigue: 59 },
      dailyLoadRanges: [
        { date: "2026-08-23", min: 0, max: 0 },
        { date: "2026-08-24", min: 20, max: 30 },
      ],
      courseEstimate: { status: "available", rangeMinutes: { min: 288, max: 312 } },
    });
  });

  it("omits a day when a planned Workout has no explicit Load", () => {
    const value = projectCyclingReadinessInput({
      today: "2026-08-22",
      raceDate: "2026-08-23",
      wellness: [],
      currentStatus: null,
      estimatedCp,
      lastSuccessfulRefreshAtMs: null,
      workouts: [{ date: "2026-08-23", name: "Ride", durationS: 3_600, structureJson: "{}" }],
    });
    expect(value.dailyLoadRanges).toEqual([]);
  });

  it("does not expose an available course estimate without a valid range and confidence", () => {
    const value = projectCyclingReadinessInput({
      today: "2026-08-22",
      raceDate: "2026-08-23",
      wellness: [],
      currentStatus: { readiness: { courseEstimate: { status: "available" } } },
      estimatedCp,
      lastSuccessfulRefreshAtMs: null,
      workouts: [],
    });
    expect(value.courseEstimate).toMatchObject({
      status: "unavailable",
      rangeMinutes: null,
      confidence: null,
      unavailableReason: "missing-course",
    });
  });

  it("classifies a structured hard-work addition during taper and leaves reductions alone", () => {
    const base = {
      planStructureJson: JSON.stringify({
        phases: [
          { focus: "build", durationWeeks: 2 },
          { focus: "taper", durationWeeks: 1 },
        ],
      }),
      planStartDate: "2026-08-03",
      planTotalWeeks: 3,
      workoutDate: "2026-08-21",
      current: { name: "Race opener", durationS: 1_800 },
    };
    expect(
      cyclingTaperRefusal({
        ...base,
        next: {
          name: "Threshold 4×8",
          durationS: 4_800,
          structureJson: JSON.stringify({ intensity: "threshold" }),
        },
      }),
    ).toEqual({ requested: "Threshold 4×8 · 1:20", kept: "Race opener · 0:30" });
    expect(
      cyclingTaperRefusal({
        ...base,
        next: { name: "Race opener", durationS: 1_200, structureJson: "{}" },
      }),
    ).toBeNull();
  });
});
