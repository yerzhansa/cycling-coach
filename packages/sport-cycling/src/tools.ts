import { tool, zodSchema } from "ai";
import { z } from "zod";
import type { MemoryStore } from "@enduragent/core";
import type { IntervalsClient } from "intervals-icu-api";
import {
  calculateCyclingZones,
  buildPlanSkeleton,
  assessGoalFeasibility,
  getSampleWeek,
  serializeIntervalsWorkout,
  intervalsWorkoutInputSchema,
  InvalidWorkoutError,
} from "./index.js";
import type {
  AthleteProfile,
  ExperienceLevel,
  VolumeTier,
  DayOfWeek,
  RaceType,
  IntervalsWorkoutInput,
} from "./index.js";

const daysEnum = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

/**
 * Pure-Sport cycling tools per ADR-0004 — sport-specific math (FTP zones,
 * periodized plan-skeleton) + the cycling-flavored intervals.icu workout
 * creator (hardcoded `type: "Ride"`). Pure-Core and Core-with-sport-config
 * intervals tools live in `@enduragent/core`'s `createPureCoreIntervalsTools`
 * and `createCoreToolsWithSportConfig`.
 */
export function createCyclingTools(
  memory: MemoryStore,
  intervals: IntervalsClient | null,
  tz: string = "UTC",
) {
  return {
    calculate_zones: tool({
      description: "Calculate 6 power zones from FTP watts",
      inputSchema: zodSchema(
        z.object({
          ftpWatts: z.number().int().min(50).max(600).describe("FTP in watts"),
        }),
      ),
      execute: async (input: { ftpWatts: number }) => calculateCyclingZones(input.ftpWatts),
    }),

    build_plan_skeleton: tool({
      description:
        "Build a periodized training plan skeleton from athlete profile. Returns phases, volume targets, zone tables, and testing protocols.",
      inputSchema: zodSchema(
        z.object({
          experienceLevel: z.enum(["beginner", "intermediate", "advanced", "elite"]),
          ftpWatts: z.number().int().min(50).max(600),
          weightKg: z.number().positive().optional(),
          volumeTier: z.enum(["low", "medium", "high"]),
          scheduleType: z.enum(["fixed", "flexible"]),
          availableDays: z.array(daysEnum).optional(),
          keySessionDay: daysEnum.optional(),
          sessionsPerWeek: z.number().int().min(3).max(6).optional(),
          goalType: z.enum(["race", "general"]),
          raceType: z
            .enum(["century", "gran_fondo", "criterium", "time_trial", "other"])
            .optional(),
          raceDate: z.string().optional(),
          targetTime: z.string().optional(),
          generalGoal: z.string().optional(),
          generalGoalTarget: z.string().optional(),
        }),
      ),
      execute: async (params: {
        experienceLevel: ExperienceLevel;
        ftpWatts: number;
        weightKg?: number;
        volumeTier: VolumeTier;
        scheduleType: "fixed" | "flexible";
        availableDays?: DayOfWeek[];
        keySessionDay?: DayOfWeek;
        sessionsPerWeek?: number;
        goalType: "race" | "general";
        raceType?: RaceType;
        raceDate?: string;
        targetTime?: string;
        generalGoal?: string;
        generalGoalTarget?: string;
      }) => {
        const profile: AthleteProfile = { ...params, needsExtraRecovery: false };
        const plan = buildPlanSkeleton(profile, tz);
        memory.savePlan(plan);
        return plan;
      },
    }),

    assess_feasibility: tool({
      description:
        "Assess whether an FTP or W/kg target is realistic given current fitness and experience level",
      inputSchema: zodSchema(
        z.object({
          currentFtp: z.number().int().min(50).max(600),
          targetFtp: z.number().int().optional(),
          targetWkg: z.number().optional(),
          currentWeightKg: z.number().positive().optional(),
          experienceLevel: z.enum(["beginner", "intermediate", "advanced", "elite"]),
        }),
      ),
      execute: async (params: {
        currentFtp: number;
        targetFtp?: number;
        targetWkg?: number;
        currentWeightKg?: number;
        experienceLevel: ExperienceLevel;
      }) => {
        const result = assessGoalFeasibility(params);
        return result ?? { message: "Goal appears achievable within one plan cycle." };
      },
    }),

    get_sample_week: tool({
      description: "Get a sample training week for a given volume tier and schedule type",
      inputSchema: zodSchema(
        z.object({
          volumeTier: z.enum(["low", "medium", "high"]),
          scheduleType: z.enum(["fixed", "flexible"]),
          availableDays: z.array(daysEnum).optional(),
          keySessionDay: daysEnum.optional(),
          sessionsPerWeek: z.number().int().min(3).max(6).optional(),
        }),
      ),
      execute: async (params: {
        volumeTier: VolumeTier;
        scheduleType: "fixed" | "flexible";
        availableDays?: DayOfWeek[];
        keySessionDay?: DayOfWeek;
        sessionsPerWeek?: number;
      }) =>
        getSampleWeek(
          params.volumeTier,
          params.scheduleType,
          params.availableDays,
          params.keySessionDay,
          params.sessionsPerWeek,
        ),
    }),

    ...(intervals
      ? {
          intervals_create_workout: tool({
            description:
              "Create a structured workout on the intervals.icu calendar. Auto-syncs to Garmin/Wahoo. " +
              "Supply the workout as structured steps — the tool serializes them into the intervals.icu " +
              "native description syntax so the power chart renders. Put athlete-facing coaching narrative " +
              "(feel, notes, hydration) in your chat reply, not in this tool.",
            inputSchema: zodSchema(
              z.object({
                date: z.string().describe("Workout date (YYYY-MM-DD)"),
                workout: intervalsWorkoutInputSchema.describe(
                  "Structured workout: name + ordered steps. Top-level steps can be simple (warmup/steady/interval/ramp/recovery/rest/cooldown/freeride) or a set {type:'set', repeat, interval, recovery}. Durations use seconds or minutes only. Power targets: {kind:'percent_ftp'|'watts'|'zone', value} or {kind, low, high} for ranges. Ramps require low+high.",
                ),
              }),
            ),
            execute: async (input: { date: string; workout: IntervalsWorkoutInput }) => {
              let serialized: ReturnType<typeof serializeIntervalsWorkout>;
              try {
                serialized = serializeIntervalsWorkout(input.workout);
              } catch (err) {
                if (err instanceof InvalidWorkoutError) {
                  return { error: "invalid_workout", details: err.message };
                }
                throw err;
              }
              const result = await intervals.events.create({
                start_date_local: `${input.date}T00:00:00`,
                category: "WORKOUT",
                name: input.workout.name,
                type: "Ride",
                moving_time: serialized.movingTime,
                icu_training_load: serialized.trainingLoad,
                description: serialized.description,
              });
              if (!result.ok) return { error: result.error.kind };
              return { created: true, event: result.value };
            },
          }),
        }
      : {}),
  };
}
