import { z } from "zod";

// ============================================================================
// SHARED ENUMS
// ============================================================================

export const experienceLevelSchema = z.enum(["beginner", "intermediate", "advanced", "elite"]);

export const volumeTierSchema = z.enum(["low", "medium", "high"]);

export const dayOfWeekSchema = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

export const scheduleTypeSchema = z.enum(["fixed", "flexible"]);

export const goalTypeSchema = z.enum(["race", "general"]);

export const raceTypeSchema = z.enum(["century", "gran_fondo", "criterium", "time_trial", "other"]);

export const cycleFocusSchema = z.enum([
  "base_building",
  "aerobic_development",
  "threshold",
  "vo2max",
  "race_prep",
  "taper",
  "recovery",
  "maintenance",
  "general_fitness",
]);

export const planStatusSchema = z.enum(["draft", "active", "paused", "completed", "archived"]);

// ============================================================================
// WORKOUT SCHEMAS
// ============================================================================

export const durationUnitSchema = z.enum(["seconds", "minutes", "distance_km", "distance_mi"]);

export const durationSchema = z.object({
  value: z.number().positive(),
  unit: durationUnitSchema,
});

export const powerTargetTypeSchema = z.enum(["percent_ftp", "watts", "zone"]);

export const powerTargetSchema = z.object({
  type: powerTargetTypeSchema,
  value: z.number(),
  low: z.number().optional(),
  high: z.number().optional(),
});

export const cadenceTargetSchema = z.object({
  target: z.number().int().positive().optional(),
  low: z.number().int().positive().optional(),
  high: z.number().int().positive().optional(),
});

export const enduranceStepTypeSchema = z.enum([
  "warmup",
  "steady",
  "ramp",
  "interval",
  "rest",
  "recovery",
  "cooldown",
  "freeride",
]);

export const cyclingStepSchema = z.object({
  type: enduranceStepTypeSchema,
  duration: durationSchema,
  power: powerTargetSchema,
  cadence: cadenceTargetSchema.optional(),
  notes: z.string().optional(),
});

const cyclingSetSubStepSchema = z.object({
  duration: durationSchema,
  power: powerTargetSchema,
  cadence: cadenceTargetSchema.optional(),
  notes: z.string().optional(),
  name: z.string().optional(),
});

export const cyclingSetStepSchema = z.object({
  type: z.literal("set"),
  repeat: z.number().int().positive(),
  interval: cyclingSetSubStepSchema,
  recovery: cyclingSetSubStepSchema,
});

export const cyclingWorkoutSchema = z.object({
  sport: z.literal("cycling"),
  name: z.string().min(1),
  indoor: z.boolean(),
  steps: z.array(z.union([cyclingStepSchema, cyclingSetStepSchema])).min(1),
  totalDuration: z.number().int().positive(),
  estimatedLoad: z.number().positive().optional(),
  rationale: z.string().min(1),
  coachNote: z.string().optional(),
  tags: z.array(z.string()).optional(),
  createdAt: z.string().datetime().optional(),
});

// ============================================================================
// TRAINING PLAN SCHEMAS
// ============================================================================

export const trainingZoneSchema = z.object({
  name: z.string(),
  range: z.string(),
  percentage: z.string().optional(),
  description: z.string(),
});

export const sportZonesTableSchema = z.object({
  sport: z.literal("cycling"),
  zones: z.array(trainingZoneSchema),
});

export const sportVolumeTargetSchema = z.object({
  sessionsPerCycle: z.number().int().positive(),
  hoursPerCycle: z.number().nonnegative().optional(),
  notes: z.string().optional(),
});

export const trainingPlanPhaseSchema = z.object({
  number: z.number().int().positive(),
  name: z.string(),
  durationWeeks: z.number().int().positive(),
  durationCycles: z.number().int().positive(),
  focus: cycleFocusSchema,
  secondaryFocus: cycleFocusSchema.optional(),
  volumeTargets: z.record(z.string(), sportVolumeTargetSchema),
  keyAdditions: z.array(z.string()),
  intensityDistribution: z.string().optional(),
});

export const progressionEntrySchema = z.object({
  cycleNumber: z.number().int().positive(),
  type: z.string().optional(),
  workout: z.string(),
  target: z.string().optional(),
  notes: z.string().optional(),
});

export const phaseProgressionSchema = z.object({
  workoutType: z.string(),
  dayInCycle: z.number().int().positive(),
  progressions: z.array(progressionEntrySchema),
});

export const testingCheckpointSchema = z.object({
  cycle: z.number().int().positive(),
  expectedValue: z.string(),
  notes: z.string().optional(),
});

export const testingProtocolSchema = z.object({
  frequency: z.string(),
  method: z.string(),
  warmupProtocol: z.string().optional(),
  checkpoints: z.array(testingCheckpointSchema),
});

export const phaseVolumeSummarySchema = z.object({
  phaseName: z.string(),
  phaseNumber: z.number().int().positive(),
  totalHours: z.number().positive(),
  hours: z.number(),
});

export const volumeSummarySchema = z.object({
  byPhase: z.array(phaseVolumeSummarySchema),
  totalPlanHours: z.number().positive().optional(),
  intensityDistribution: z.string(),
});

export const schedulePreferencesSchema = z.object({
  scheduleType: scheduleTypeSchema,
  availableDays: z.array(dayOfWeekSchema).optional(),
  keySessionDay: dayOfWeekSchema.optional(),
  sessionsPerWeek: z.number().int().min(3).max(6).optional(),
});

export const trainingPlanSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  primaryGoal: z.string(),
  targetDate: z.string().datetime().optional(),
  totalWeeks: z.number().int().positive(),
  cycleLength: z.number().int().positive(),
  cycleStructureDescription: z.string(),
  phases: z.array(trainingPlanPhaseSchema).min(1),
  zoneTables: z.array(sportZonesTableSchema),
  progressions: z.array(phaseProgressionSchema),
  testingProtocols: z.array(testingProtocolSchema),
  volumeSummary: volumeSummarySchema,
  schedulePreferences: schedulePreferencesSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime().optional(),
  status: planStatusSchema.optional(),
  rationale: z.string().optional(),
  feasibilityContext: z
    .object({
      ultimateTarget: z.string(),
      realisticMilestone: z.string(),
      gapPercentage: z.number(),
      estimatedCycles: z.number(),
      severity: z.enum(["warning", "ambitious"]),
    })
    .optional(),
});

// ============================================================================
// ATHLETE PROFILE SCHEMA
// ============================================================================

export const athleteProfileSchema = z.object({
  experienceLevel: experienceLevelSchema,
  ftpWatts: z.number().int().min(50).max(600),
  weightKg: z.number().positive().optional(),
  volumeTier: volumeTierSchema,
  scheduleType: scheduleTypeSchema,
  availableDays: z.array(dayOfWeekSchema).optional(),
  keySessionDay: dayOfWeekSchema.optional(),
  sessionsPerWeek: z.number().int().min(3).max(6).optional(),
  needsExtraRecovery: z.boolean().default(false),
  goalType: goalTypeSchema,
  raceType: raceTypeSchema.optional(),
  raceDate: z.string().optional(),
  targetTime: z.string().optional(),
  generalGoal: z.string().optional(),
  generalGoalTarget: z.string().optional(),
});

// ============================================================================
// TYPE EXPORTS
// ============================================================================

export type ExperienceLevel = z.infer<typeof experienceLevelSchema>;
export type VolumeTier = z.infer<typeof volumeTierSchema>;
export type DayOfWeek = z.infer<typeof dayOfWeekSchema>;
export type ScheduleType = z.infer<typeof scheduleTypeSchema>;
export type GoalType = z.infer<typeof goalTypeSchema>;
export type RaceType = z.infer<typeof raceTypeSchema>;
export type CycleFocus = z.infer<typeof cycleFocusSchema>;
export type PlanStatus = z.infer<typeof planStatusSchema>;

export type DurationUnit = z.infer<typeof durationUnitSchema>;
export type Duration = z.infer<typeof durationSchema>;
export type PowerTargetType = z.infer<typeof powerTargetTypeSchema>;
export type PowerTarget = z.infer<typeof powerTargetSchema>;
export type CadenceTarget = z.infer<typeof cadenceTargetSchema>;
export type EnduranceStepType = z.infer<typeof enduranceStepTypeSchema>;
export type CyclingStep = z.infer<typeof cyclingStepSchema>;
export type CyclingSetStep = z.infer<typeof cyclingSetStepSchema>;
export type CyclingWorkout = z.infer<typeof cyclingWorkoutSchema>;

export type TrainingZone = z.infer<typeof trainingZoneSchema>;
export type SportZonesTable = z.infer<typeof sportZonesTableSchema>;
export type SportVolumeTarget = z.infer<typeof sportVolumeTargetSchema>;
export type TrainingPlanPhase = z.infer<typeof trainingPlanPhaseSchema>;
export type TrainingPlan = z.infer<typeof trainingPlanSchema>;
export type SchedulePreferences = z.infer<typeof schedulePreferencesSchema>;
export type VolumeSummary = z.infer<typeof volumeSummarySchema>;
export type TestingProtocol = z.infer<typeof testingProtocolSchema>;
export type AthleteProfile = z.infer<typeof athleteProfileSchema>;
