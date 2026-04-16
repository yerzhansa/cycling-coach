import { describe, it, expect } from "vitest";
import { assessGoalFeasibility } from "../src/cycling/feasibility.js";

describe("assessGoalFeasibility", () => {
  it("returns null when target is below current FTP", () => {
    const result = assessGoalFeasibility({
      currentFtp: 250,
      targetFtp: 240,
      experienceLevel: "intermediate",
    });
    expect(result).toBeNull();
  });

  it("returns null when gap is within expected gain", () => {
    const result = assessGoalFeasibility({
      currentFtp: 250,
      targetFtp: 280, // 12% gain, within 20% threshold for intermediate
      experienceLevel: "intermediate",
    });
    expect(result).toBeNull();
  });

  it("returns warning for moderately ambitious FTP target", () => {
    const result = assessGoalFeasibility({
      currentFtp: 200,
      targetFtp: 280, // 40% gain
      experienceLevel: "intermediate",
    });
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("warning");
    expect(result!.gapPercentage).toBe(40);
    expect(result!.estimatedCycles).toBeGreaterThan(1);
    expect(result!.realisticMilestone).toContain("W");
  });

  it("returns ambitious for very large FTP gap", () => {
    const result = assessGoalFeasibility({
      currentFtp: 200,
      targetFtp: 350, // 75% gain
      experienceLevel: "intermediate",
    });
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("ambitious");
  });

  it("assesses W/kg targets", () => {
    const result = assessGoalFeasibility({
      currentFtp: 250,
      targetWkg: 5.5,
      currentWeightKg: 75, // current 3.33 W/kg → 5.5 = 65% gap (> 50% ambitious threshold)
      experienceLevel: "intermediate",
    });
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("ambitious");
    expect(result!.realisticMilestone).toContain("W/kg");
  });

  it("elite athletes have tighter thresholds", () => {
    const result = assessGoalFeasibility({
      currentFtp: 350,
      targetFtp: 400, // ~14% gain — within intermediate range but not elite
      experienceLevel: "elite",
    });
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("warning");
  });

  it("returns null with no target", () => {
    const result = assessGoalFeasibility({
      currentFtp: 250,
      experienceLevel: "intermediate",
    });
    expect(result).toBeNull();
  });
});
