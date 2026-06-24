import { describe, it, expect } from "vitest";
import periodization from "../skills/periodization.md";
import raceprep from "../skills/race-prep.md";

describe("skill prose carries no transcribed plan-builder constants", () => {
  it("periodization.md carries no plan-builder constant", () => {
    expect(periodization).not.toMatch(/\b[234]:1\b/);
    expect(periodization).not.toMatch(/(1\.0|1\.1|1\.15|0\.6|0\.7)x/);
    expect(periodization).not.toMatch(/\d+% easy/);
  });

  it("race-prep.md carries no taper-weeks lookup", () => {
    expect(raceprep).not.toMatch(/[12]\s+(week|weeks)\s+taper/);
  });

  it("periodization.md carries no transcribed model-selection branch table", () => {
    expect(periodization).not.toMatch(/Beginner\s*→\s*Linear/i);
  });

  it("periodization.md steers to the tool", () => {
    expect(periodization).toContain("build_plan_skeleton");
  });

  it("race-prep.md steers to the tool", () => {
    expect(raceprep).toContain("build_plan_skeleton");
  });
});
