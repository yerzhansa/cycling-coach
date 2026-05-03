import { randomUUID } from "node:crypto";
import type {
  AthleteProfile,
  TrainingPlan,
  TrainingPlanPhase,
  SportZonesTable,
  TestingProtocol,
  VolumeSummary,
  SchedulePreferences,
  VolumeTier,
} from "./schemas.js";
import { calculateCyclingZones, ZONE_DESCRIPTIONS } from "./zones.js";
import {
  computeTotalWeeks,
  selectPeriodizationModel,
  PHASE_TEMPLATES,
  TAPER_WEEKS,
  VOLUME_TIER_MAPPING,
  VOLUME_PROGRESSION,
  INTENSITY_DISTRIBUTIONS,
  BUILD_RECOVERY_RATIOS,
  type PeriodizationModel,
} from "./periodization.js";

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

export function buildPlanSkeleton(profile: AthleteProfile, tz: string = "UTC"): TrainingPlan {
  const totalWeeks = computeTotalWeeks(profile, tz);
  const model = selectPeriodizationModel(profile, totalWeeks);
  const cycleLength = 7;

  const phases = buildPhases(profile, totalWeeks, model, cycleLength);
  const zoneTables = buildZoneTables(profile);
  const testingProtocols = buildTestingProtocols(phases);
  const volumeSummary = buildVolumeSummary(phases);
  const schedulePreferences = buildSchedulePreferences(profile);

  const ratio = BUILD_RECOVERY_RATIOS[profile.experienceLevel];
  const now = new Date().toISOString();

  return {
    id: randomUUID(),
    name: `${totalWeeks}-Week Plan`,
    primaryGoal:
      profile.goalType === "race"
        ? `${profile.raceType ?? "race"}${profile.targetTime ? ` in ${profile.targetTime}` : ""}`
        : (profile.generalGoal ?? "General fitness improvement"),
    targetDate: profile.raceDate ? toISO(profile.raceDate) : undefined,
    totalWeeks,
    cycleLength,
    cycleStructureDescription: `${cycleLength}-day cycles with ${ratio.build}:${ratio.recovery} build/recovery`,
    phases,
    zoneTables,
    progressions: [],
    testingProtocols,
    volumeSummary,
    schedulePreferences,
    createdAt: now,
    updatedAt: now,
    status: "draft",
  };
}

// ============================================================================
// HELPERS
// ============================================================================

function toISO(dateStr: string): string {
  if (dateStr.includes("T")) return dateStr;
  return `${dateStr}T00:00:00.000Z`;
}

// ============================================================================
// PHASE BUILDING
// ============================================================================

function buildPhases(
  profile: AthleteProfile,
  totalWeeks: number,
  model: PeriodizationModel,
  cycleLength: number,
): TrainingPlanPhase[] {
  const taperWeeks =
    profile.goalType === "race" && profile.raceType ? (TAPER_WEEKS[profile.raceType] ?? 0) : 0;
  const remainingWeeks = totalWeeks - taperWeeks;
  const templates = PHASE_TEMPLATES[model];

  const rawWeeks = templates.map((t) => t.pct * remainingWeeks);
  const roundedWeeks = distributeWeeks(rawWeeks, remainingWeeks);

  const volumeTier = profile.volumeTier;
  const totalPhases = templates.length + (taperWeeks > 0 ? 1 : 0);

  const maxSessions =
    profile.scheduleType === "fixed" && profile.availableDays?.length
      ? profile.availableDays.length
      : (profile.sessionsPerWeek ?? undefined);

  const phases: TrainingPlanPhase[] = templates.map((template, i) => {
    const weeks = roundedWeeks[i];
    const hasTaper = taperWeeks > 0;
    const volumeTargets = computeVolumeTargets(volumeTier, i, totalPhases, hasTaper, maxSessions);
    return {
      number: i + 1,
      name: `Phase ${i + 1}`,
      durationWeeks: weeks,
      durationCycles: Math.ceil((weeks * 7) / cycleLength),
      focus: template.focus,
      volumeTargets: { cycling: volumeTargets },
      keyAdditions: [],
    };
  });

  if (taperWeeks > 0) {
    const taperIdx = phases.length;
    const volumeTargets = computeVolumeTargets(
      volumeTier,
      taperIdx,
      totalPhases,
      true,
      maxSessions,
    );
    phases.push({
      number: taperIdx + 1,
      name: `Phase ${taperIdx + 1}`,
      durationWeeks: taperWeeks,
      durationCycles: Math.ceil((taperWeeks * 7) / cycleLength),
      focus: "taper",
      volumeTargets: { cycling: volumeTargets },
      keyAdditions: [],
    });
  }

  return phases;
}

function distributeWeeks(rawWeeks: number[], total: number): number[] {
  const rounded = rawWeeks.map((w) => Math.max(1, Math.round(w)));
  let sum = rounded.reduce((s, w) => s + w, 0);

  while (sum > total) {
    const maxIdx = rounded.reduce((mi, w, i) => (w > rounded[mi] ? i : mi), 0);
    if (rounded[maxIdx] <= 1) break;
    rounded[maxIdx]--;
    sum--;
  }
  while (sum < total) {
    const minIdx = rounded.reduce((mi, w, i) => (w < rounded[mi] ? i : mi), 0);
    rounded[minIdx]++;
    sum++;
  }

  return rounded;
}

// ============================================================================
// VOLUME TARGETS
// ============================================================================

function computeVolumeTargets(
  volumeTier: VolumeTier,
  phaseIndex: number,
  totalPhases: number,
  hasTaper: boolean,
  maxSessions?: number,
): { sessionsPerCycle: number; hoursPerCycle: number } {
  const tierData = VOLUME_TIER_MAPPING[volumeTier];

  const baseSessions = Math.round(
    (tierData.sessionsPerWeek.min + tierData.sessionsPerWeek.max) / 2,
  );
  const baseHours = (tierData.hoursPerWeek.min + tierData.hoursPerWeek.max) / 2;

  let multiplier: number;
  if (phaseIndex === totalPhases - 1 && totalPhases > 1) {
    multiplier = hasTaper ? VOLUME_PROGRESSION.taper : VOLUME_PROGRESSION.peak;
  } else if (phaseIndex === totalPhases - 2 && totalPhases > 2) {
    multiplier = VOLUME_PROGRESSION.peak;
  } else if (phaseIndex === 0) {
    multiplier = VOLUME_PROGRESSION.base;
  } else {
    multiplier = VOLUME_PROGRESSION.build;
  }

  let sessions = Math.max(1, Math.round(baseSessions * multiplier));
  if (maxSessions !== undefined) {
    sessions = Math.min(sessions, maxSessions);
  }

  return {
    sessionsPerCycle: sessions,
    hoursPerCycle: Math.round(baseHours * multiplier * 10) / 10,
  };
}

// ============================================================================
// ZONE TABLES
// ============================================================================

function buildZoneTables(profile: AthleteProfile): SportZonesTable[] {
  const zones = calculateCyclingZones(profile.ftpWatts);
  return [
    {
      sport: "cycling",
      zones: zones.map((z) => ({
        name: z.label,
        range: z.value,
        description: ZONE_DESCRIPTIONS[z.label] ?? "Training zone",
      })),
    },
  ];
}

// ============================================================================
// TESTING PROTOCOLS
// ============================================================================

function buildTestingProtocols(phases: TrainingPlanPhase[]): TestingProtocol[] {
  const totalCycles = phases.reduce((sum, p) => sum + p.durationCycles, 0);
  if (totalCycles === 0) return [];

  const checkpointCycles: number[] = [];
  for (let c = 4; c <= totalCycles; c += 4) {
    checkpointCycles.push(c);
  }
  if (checkpointCycles.length === 0 && totalCycles >= 1) {
    checkpointCycles.push(totalCycles);
  }

  return [
    {
      frequency: "Every 4 weeks",
      method: "20-minute FTP test",
      checkpoints: checkpointCycles.map((c) => ({
        cycle: c,
        expectedValue: "TBD",
      })),
    },
  ];
}

// ============================================================================
// VOLUME SUMMARY
// ============================================================================

function buildVolumeSummary(phases: TrainingPlanPhase[]): VolumeSummary {
  let totalPlanHours = 0;

  const byPhase = phases.map((p) => {
    let phaseHours = 0;
    for (const target of Object.values(p.volumeTargets)) {
      const hours = (target.hoursPerCycle ?? target.sessionsPerCycle) * p.durationCycles;
      phaseHours += hours;
    }

    phaseHours = Math.max(0.1, Math.round(phaseHours * 10) / 10);
    totalPlanHours += phaseHours;

    return {
      phaseName: p.name,
      phaseNumber: p.number,
      totalHours: phaseHours,
      hours: phaseHours,
    };
  });

  const firstFocus = phases[0]?.focus ?? "general_fitness";

  return {
    byPhase,
    totalPlanHours: Math.max(0.1, Math.round(totalPlanHours * 10) / 10),
    intensityDistribution:
      INTENSITY_DISTRIBUTIONS[firstFocus] ?? INTENSITY_DISTRIBUTIONS.general_fitness,
  };
}

// ============================================================================
// SCHEDULE PREFERENCES
// ============================================================================

function buildSchedulePreferences(profile: AthleteProfile): SchedulePreferences {
  return {
    scheduleType: profile.scheduleType,
    availableDays: profile.availableDays,
    keySessionDay: profile.keySessionDay,
    sessionsPerWeek: profile.sessionsPerWeek,
  };
}
