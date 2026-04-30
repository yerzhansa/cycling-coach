import { describe, it, expect } from "vitest";
import { buildPlanSkeleton } from "../src/plan-builder.js";
import type { AthleteProfile } from "../src/schemas.js";

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

describe("buildPlanSkeleton", () => {
  it("builds a valid plan for a general fitness goal", () => {
    const plan = buildPlanSkeleton(makeProfile());

    expect(plan.totalWeeks).toBe(12);
    expect(plan.phases.length).toBeGreaterThanOrEqual(3);
    expect(plan.zoneTables).toHaveLength(1);
    expect(plan.zoneTables[0].sport).toBe("cycling");
    expect(plan.zoneTables[0].zones).toHaveLength(6);
    expect(plan.testingProtocols).toHaveLength(1);
    expect(plan.testingProtocols[0].method).toBe("20-minute FTP test");
    expect(plan.status).toBe("draft");
  });

  it("adds taper phase for race goals", () => {
    const plan = buildPlanSkeleton(makeProfile({ goalType: "race", raceType: "gran_fondo" }));

    const lastPhase = plan.phases[plan.phases.length - 1];
    expect(lastPhase.focus).toBe("taper");
    expect(lastPhase.durationWeeks).toBe(2);
  });

  it("phase weeks sum to totalWeeks", () => {
    const plan = buildPlanSkeleton(makeProfile());
    const phaseWeeks = plan.phases.reduce((sum, p) => sum + p.durationWeeks, 0);
    expect(phaseWeeks).toBe(plan.totalWeeks);
  });

  it("respects fixed schedule session limits", () => {
    const plan = buildPlanSkeleton(
      makeProfile({
        scheduleType: "fixed",
        availableDays: ["mon", "wed", "sat"],
      }),
    );

    for (const phase of plan.phases) {
      expect(phase.volumeTargets["cycling"].sessionsPerCycle).toBeLessThanOrEqual(3);
    }
  });

  it("generates zone table from FTP", () => {
    const plan = buildPlanSkeleton(makeProfile({ ftpWatts: 300 }));
    const zones = plan.zoneTables[0].zones;

    expect(zones[0].name).toBe("Z1 Active Recovery");
    expect(zones[0].range).toContain("165W");
  });

  it("includes volume summary", () => {
    const plan = buildPlanSkeleton(makeProfile());

    expect(plan.volumeSummary.byPhase.length).toBe(plan.phases.length);
    expect(plan.volumeSummary.totalPlanHours).toBeGreaterThan(0);
    expect(plan.volumeSummary.intensityDistribution).toContain("easy");
  });

  it("sets schedule preferences", () => {
    const plan = buildPlanSkeleton(
      makeProfile({
        scheduleType: "fixed",
        availableDays: ["tue", "thu", "sat", "sun"],
        keySessionDay: "sat",
      }),
    );

    expect(plan.schedulePreferences?.scheduleType).toBe("fixed");
    expect(plan.schedulePreferences?.availableDays).toContain("sat");
    expect(plan.schedulePreferences?.keySessionDay).toBe("sat");
  });
});
