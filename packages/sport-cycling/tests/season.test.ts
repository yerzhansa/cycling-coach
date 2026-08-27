import { describe, expect, it } from "vitest";
import { projectCyclingSeasonMetadata } from "../src/season.js";

describe("cycling Season metadata", () => {
  it("prefers explicit week labels and keeps accepted race metadata", () => {
    expect(
      projectCyclingSeasonMetadata(
        {
          seasonWeeks: [
            { phase: "Base", purpose: "Endurance" },
            { phase: "Recovery", purpose: "Absorb" },
          ],
          racePriority: "a",
          raceDistanceKm: 120,
          seasonConstraint: { weekIndex: 2, title: "FTP refresh", detail: "Refresh first." },
        },
        2,
      ),
    ).toEqual({
      weeks: [
        { phase: "Base", purpose: "Endurance" },
        { phase: "Recovery", purpose: "Absorb" },
      ],
      priority: "A",
      distanceKm: 120,
      constraint: { weekIndex: 2, title: "FTP refresh", detail: "Refresh first." },
    });
  });

  it("expands legacy cycling phases into week labels", () => {
    expect(
      projectCyclingSeasonMetadata(
        {
          phases: [
            { durationWeeks: 2, focus: "base_building", name: "Phase 1" },
            { durationWeeks: 1, focus: "taper", displayName: "Taper" },
          ],
        },
        3,
      ).weeks,
    ).toEqual([
      { phase: "Phase 1", purpose: "Build aerobic durability" },
      { phase: "Phase 1", purpose: "Build aerobic durability" },
      { phase: "Taper", purpose: "Reduce volume; keep sharpness" },
    ]);
  });

  it("uses honest generic labels when optional phase metadata is absent or incomplete", () => {
    expect(projectCyclingSeasonMetadata({}, 2)).toEqual({
      weeks: [
        { phase: "Plan", purpose: "Follow the approved week" },
        { phase: "Plan", purpose: "Follow the approved week" },
      ],
      priority: null,
      distanceKm: null,
      constraint: null,
    });
  });
});
