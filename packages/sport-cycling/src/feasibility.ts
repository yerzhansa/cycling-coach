import type { ExperienceLevel } from "./schemas.js";

// ============================================================================
// TYPES
// ============================================================================

export interface FeasibilityInput {
  currentFtp: number;
  targetFtp?: number;
  targetWkg?: number;
  currentWeightKg?: number;
  experienceLevel: ExperienceLevel;
}

export interface FeasibilityResult {
  severity: "warning" | "ambitious";
  gapPercentage: number;
  realisticMilestone: string;
  estimatedCycles: number;
  coachMessage: string;
  enricherHint: string;
}

// ============================================================================
// THRESHOLD CONSTANTS
// ============================================================================

const FTP_THRESHOLDS: Record<
  ExperienceLevel,
  {
    expectedGain: number;
    warningThreshold: number;
    ambitiousThreshold: number;
  }
> = {
  beginner: {
    expectedGain: 0.25,
    warningThreshold: 0.25,
    ambitiousThreshold: 0.5,
  },
  intermediate: {
    expectedGain: 0.2,
    warningThreshold: 0.2,
    ambitiousThreshold: 0.5,
  },
  advanced: {
    expectedGain: 0.15,
    warningThreshold: 0.15,
    ambitiousThreshold: 0.4,
  },
  elite: {
    expectedGain: 0.08,
    warningThreshold: 0.1,
    ambitiousThreshold: 0.2,
  },
};

// ============================================================================
// HELPERS
// ============================================================================

function roundTo(value: number, nearest: number): number {
  return Math.round(value / nearest) * nearest;
}

function buildCoachMessage(
  severity: "warning" | "ambitious",
  target: string,
  current: string,
  milestone: string,
  estimatedCycles: number,
): string {
  if (severity === "warning") {
    return `Your target of ${target} is a big jump from ${current}. A realistic goal for this plan is around ${milestone} — think of this as the first step toward ${target}.`;
  }
  const years = (estimatedCycles * 0.33).toFixed(1);
  return `Going from ${current} to ${target} typically takes ${estimatedCycles} plan cycles (~${years} years of consistent training). This plan will focus on building to ${milestone}, setting you up for continued growth.`;
}

function buildEnricherHint(
  target: string,
  current: string,
  milestone: string,
  severity: "warning" | "ambitious",
  gapPercentage: number,
  estimatedCycles: number,
): string {
  return `The athlete targets ${target} but currently benchmarks at ${current}. This is a ${severity} gap (${gapPercentage}% improvement needed). Frame this plan as the first phase of a multi-plan journey. Realistic milestone for this plan: ${milestone}. Use the milestone (not the ultimate target) in the plan's primaryGoal. Acknowledge the athlete's long-term ${target} target in the rationale. Estimated ${estimatedCycles} plan cycles to reach their ultimate target.`;
}

// ============================================================================
// MAIN FUNCTION
// ============================================================================

export function assessGoalFeasibility(input: FeasibilityInput): FeasibilityResult | null {
  if (input.targetWkg && input.currentWeightKg && input.currentFtp) {
    return assessWkg(input);
  }
  if (input.targetFtp && input.currentFtp) {
    return assessFtp(input.currentFtp, input.targetFtp, input.experienceLevel);
  }
  return null;
}

// ============================================================================
// FTP ASSESSMENT
// ============================================================================

function assessFtp(
  currentFtp: number,
  targetFtp: number,
  experienceLevel: ExperienceLevel,
): FeasibilityResult | null {
  if (currentFtp <= 0) return null;

  const thresholds = FTP_THRESHOLDS[experienceLevel];
  const gapFraction = (targetFtp - currentFtp) / currentFtp;

  if (gapFraction <= 0) return null;
  if (gapFraction <= thresholds.warningThreshold) return null;

  const severity: "warning" | "ambitious" =
    gapFraction > thresholds.ambitiousThreshold ? "ambitious" : "warning";

  const milestoneRaw = currentFtp * (1 + thresholds.expectedGain);
  const milestone = roundTo(milestoneRaw, 5);
  const gapPercentage = Math.round(gapFraction * 100);
  const estimatedCycles = Math.ceil(
    Math.log(targetFtp / currentFtp) / Math.log(1 + thresholds.expectedGain),
  );

  const milestoneStr = `${milestone}W`;
  const currentStr = `${currentFtp}W`;
  const targetStr = `${targetFtp}W`;

  return {
    severity,
    gapPercentage,
    realisticMilestone: milestoneStr,
    estimatedCycles,
    coachMessage: buildCoachMessage(severity, targetStr, currentStr, milestoneStr, estimatedCycles),
    enricherHint: buildEnricherHint(
      targetStr,
      currentStr,
      milestoneStr,
      severity,
      gapPercentage,
      estimatedCycles,
    ),
  };
}

// ============================================================================
// W/KG ASSESSMENT
// ============================================================================

function assessWkg(input: FeasibilityInput): FeasibilityResult | null {
  const currentFtp = input.currentFtp;
  const currentWeightKg = input.currentWeightKg!;
  const targetWkg = input.targetWkg!;

  if (currentWeightKg <= 0 || currentFtp <= 0) return null;

  const currentWkg = currentFtp / currentWeightKg;
  const gapFraction = (targetWkg - currentWkg) / currentWkg;

  if (gapFraction <= 0) return null;

  const thresholds = FTP_THRESHOLDS[input.experienceLevel];
  if (gapFraction <= thresholds.warningThreshold) return null;

  const severity: "warning" | "ambitious" =
    gapFraction > thresholds.ambitiousThreshold ? "ambitious" : "warning";

  const milestoneWkg = currentWkg * (1 + thresholds.expectedGain);
  const milestoneStr = `${milestoneWkg.toFixed(1)} W/kg`;
  const gapPercentage = Math.round(gapFraction * 100);
  const estimatedCycles = Math.ceil(
    Math.log(targetWkg / currentWkg) / Math.log(1 + thresholds.expectedGain),
  );

  const currentStr = `${currentWkg.toFixed(1)} W/kg`;
  const targetStr = `${targetWkg} W/kg`;

  return {
    severity,
    gapPercentage,
    realisticMilestone: milestoneStr,
    estimatedCycles,
    coachMessage: buildCoachMessage(severity, targetStr, currentStr, milestoneStr, estimatedCycles),
    enricherHint: buildEnricherHint(
      targetStr,
      currentStr,
      milestoneStr,
      severity,
      gapPercentage,
      estimatedCycles,
    ),
  };
}
