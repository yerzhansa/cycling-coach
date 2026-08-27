import { describe, expect, it } from "vitest";
import {
  failedPlanReadiness,
  projectPlanReadiness,
  refreshingPlanReadiness,
} from "../src/planning/readiness.js";

function input() {
  return {
    today: "2026-08-22",
    raceDate: "2026-08-24",
    platformSeed: {
      asOf: "2026-08-22",
      fitness: 60,
      fatigue: 59,
      lastSuccessfulRefreshAtMs: 1_777_000_000_000,
    },
    dailyLoadRanges: [
      { date: "2026-08-23", min: 0, max: 0 },
      { date: "2026-08-24", min: 20, max: 30 },
    ],
    supportedDistanceKm: { min: 135, max: 145 },
    missedKeyWorkouts: 0,
    fatigue: "normal" as const,
    courseEstimate: {
      status: "available" as const,
      rangeMinutes: { min: 288, max: 312 },
      previousRangeMinutes: null,
      confidence: "moderate" as const,
      assumptions: ["Dry roads", "Low wind"],
      changedAssumption: null,
      unavailableReason: null,
    },
    evidence: {
      prescribedDurationS: 154_800,
      riddenDurationS: 142_800,
      adjustedDurationS: 7_800,
    },
  };
}

describe("Plan readiness projection", () => {
  it("projects a forward-only 42/7 Form range without mutating inputs", () => {
    const value = input();
    const before = structuredClone(value);
    const result = projectPlanReadiness(value);
    expect(result).toMatchObject({
      scenarioId: "PL-S012",
      projection: {
        form: {
          status: "available",
          current: 1,
          raceRange: { min: 10, max: 11 },
          assumptions: ["Planned training", "Normal recovery"],
        },
        feasibility: { verdict: "on-track" },
      },
    });
    expect(value).toEqual(before);
  });

  it.each([
    ["missing platform seed", { platformSeed: null }, "missing-platform-seed"],
    ["missing planned Load", { dailyLoadRanges: [] }, "missing-planned-load"],
  ])("keeps Form unavailable for %s", (_label, override, reason) => {
    const result = projectPlanReadiness({ ...input(), ...override });
    expect(result).toMatchObject({
      scenarioId: "PL-S076",
      projection: { form: { status: "unavailable", unavailableReason: reason } },
    });
  });

  it("separates changed assumptions, at-risk evidence, and missing course estimates", () => {
    expect(
      projectPlanReadiness({
        ...input(),
        courseEstimate: {
          ...input().courseEstimate,
          status: "changed",
          previousRangeMinutes: { min: 288, max: 312 },
          rangeMinutes: { min: 300, max: 328 },
          changedAssumption: "Wind is now moderate instead of low.",
        },
      }).scenarioId,
    ).toBe("PL-S077");
    expect(
      projectPlanReadiness({
        ...input(),
        fatigue: "above-normal",
        missedKeyWorkouts: 2,
      }).scenarioId,
    ).toBe("PL-S074");
    expect(
      projectPlanReadiness({
        ...input(),
        courseEstimate: {
          status: "unavailable",
          rangeMinutes: null,
          previousRangeMinutes: null,
          confidence: null,
          assumptions: [],
          changedAssumption: null,
          unavailableReason: "missing-course",
        },
      }).scenarioId,
    ).toBe("PL-S075");
  });

  it("keeps the safe projection while refresh runs and exposes a retryable failure", () => {
    const projected = projectPlanReadiness(input()).projection;
    expect(refreshingPlanReadiness(projected)).toMatchObject({
      form: { status: "refreshing", raceRange: projected.form.raceRange },
    });
    expect(failedPlanReadiness(projected)).toMatchObject({
      form: { status: "unavailable", unavailableReason: "refresh-failed" },
      courseEstimate: projected.courseEstimate,
      error: { code: "provider-failed", retryable: true },
    });
  });
});
