import { describe, it, expect } from "vitest";
import { selectPeriodizationModel, computeTotalWeeks } from "../src/cycling/periodization.js";
import type { AthleteProfile } from "../src/cycling/schemas.js";

function makeProfile(overrides: Partial<AthleteProfile> = {}): AthleteProfile {
  return {
    experienceLevel: "intermediate",
    ftpWatts: 250,
    volumeTier: "medium",
    scheduleType: "flexible",
    sessionsPerWeek: 4,
    needsExtraRecovery: false,
    goalType: "general",
    ...overrides,
  };
}

describe("selectPeriodizationModel", () => {
  it("selects linear for beginners", () => {
    const p = makeProfile({ experienceLevel: "beginner" });
    expect(selectPeriodizationModel(p, 12)).toBe("linear");
  });

  it("selects reverse_linear for short plans (<= 8 weeks)", () => {
    const p = makeProfile({ experienceLevel: "intermediate" });
    expect(selectPeriodizationModel(p, 8)).toBe("reverse_linear");
  });

  it("selects polarized for advanced + high volume", () => {
    const p = makeProfile({
      experienceLevel: "advanced",
      volumeTier: "high",
    });
    expect(selectPeriodizationModel(p, 16)).toBe("polarized");
  });

  it("selects block for intermediate + race goal", () => {
    const p = makeProfile({
      experienceLevel: "intermediate",
      goalType: "race",
    });
    expect(selectPeriodizationModel(p, 12)).toBe("block");
  });

  it("falls back to pyramidal", () => {
    const p = makeProfile({
      experienceLevel: "intermediate",
      goalType: "general",
    });
    expect(selectPeriodizationModel(p, 12)).toBe("pyramidal");
  });
});

describe("computeTotalWeeks", () => {
  it("calculates weeks from race date", () => {
    const future = new Date();
    future.setDate(future.getDate() + 84); // 12 weeks
    const p = makeProfile({
      goalType: "race",
      raceDate: future.toISOString().split("T")[0],
      raceType: "gran_fondo",
    });
    const weeks = computeTotalWeeks(p);
    expect(weeks).toBeGreaterThanOrEqual(11);
    expect(weeks).toBeLessThanOrEqual(13);
  });

  it("clamps to minimum 8 weeks", () => {
    const near = new Date();
    near.setDate(near.getDate() + 14); // 2 weeks out
    const p = makeProfile({
      goalType: "race",
      raceDate: near.toISOString().split("T")[0],
    });
    expect(computeTotalWeeks(p)).toBe(8);
  });

  it("clamps to maximum 24 weeks", () => {
    const far = new Date();
    far.setDate(far.getDate() + 365);
    const p = makeProfile({
      goalType: "race",
      raceDate: far.toISOString().split("T")[0],
    });
    expect(computeTotalWeeks(p)).toBe(24);
  });

  it("uses race type defaults when no date", () => {
    const p = makeProfile({ goalType: "race", raceType: "century" });
    expect(computeTotalWeeks(p)).toBe(12);
  });

  it("uses experience defaults for general goals", () => {
    const p = makeProfile({
      goalType: "general",
      experienceLevel: "beginner",
    });
    expect(computeTotalWeeks(p)).toBe(8);
  });
});
