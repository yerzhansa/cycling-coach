import { tool, zodSchema } from "ai";
import { z } from "zod";
import {
  buildCoachEventProvenance,
  dateKeySchema,
  isRealDateKey,
  validateWorkoutCreationDate,
} from "@enduragent/core";
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
} from "./index.js";

const daysEnum = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

export const buildPlanSkeletonInputSchema = z.object({
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
  raceDate: dateKeySchema.optional().describe("Target race date, YYYY-MM-DD"),
  targetTime: z.string().optional().describe("Goal finish time, e.g. 5:30:00"),
  generalGoal: z.string().optional(),
  generalGoalTarget: z.string().optional(),
});

// Flat object rather than a discriminated union: OpenAI-compatible providers
// (DeepSeek, OpenAI, Qwen, Kimi, …) require every tool's parameters to be a
// top-level `type: "object"` JSON Schema and reject the root-level `anyOf` that
// a discriminated union serializes to. Per-`type` field requirements are
// enforced by the superRefine below instead of by the type-level union.
export const cyclingCreateWorkoutInputSchema = z
  .object({
    type: z
      .enum(["cycling", "strength"])
      .describe('"cycling" for structured power steps, "strength" for a free-text session'),
    date: dateKeySchema.describe("Workout date (YYYY-MM-DD)"),
    workout: intervalsWorkoutInputSchema
      .optional()
      .describe(
        'Required when type is "cycling". Structured workout: name + ordered steps — simple steps or repeat sets. Use value for a single power target, or low+high for ranges; ramps require low+high. Durations are seconds or minutes only.',
      ),
    name: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe('Required when type is "strength". Calendar card title, e.g. \'Lower body 45min\''),
    description: z
      .string()
      .min(1)
      .max(4000)
      .optional()
      .describe('Required when type is "strength". Free-text session — exercises, sets, reps, weight/RPE.'),
  })
  .superRefine((val, ctx) => {
    if (val.type === "cycling") {
      if (val.workout === undefined) {
        ctx.addIssue({
          code: "custom",
          message: 'workout is required when type is "cycling"',
          path: ["workout"],
        });
      }
    } else {
      if (val.name === undefined) {
        ctx.addIssue({
          code: "custom",
          message: 'name is required when type is "strength"',
          path: ["name"],
        });
      }
      if (val.description === undefined) {
        ctx.addIssue({
          code: "custom",
          message: 'description is required when type is "strength"',
          path: ["description"],
        });
      }
    }
  });

export type CyclingCreateWorkoutInput = z.infer<typeof cyclingCreateWorkoutInputSchema>;

/**
 * Pure-Sport cycling tools per ADR-0004 — sport-specific math (FTP zones,
 * periodized plan-skeleton) + the cycling-flavored intervals.icu workout
 * creator (hardcoded `type: "Ride"`). Pure-Core and Core-with-sport-config
 * intervals tools live in `@enduragent/core`'s `createPureCoreIntervalsTools`
 * and `createCoreToolsWithSportConfig`.
 */
export function createCyclingTools(
  intervals: IntervalsClient | null,
  tz: string = "UTC",
) {
  return {
    calculate_zones: tool({
      description: "Calculate power-zone watt ranges from FTP watts (7-zone numbering)",
      inputSchema: zodSchema(
        z.object({
          ftpWatts: z.number().int().min(50).max(600).describe("FTP in watts"),
        }),
      ),
      execute: async (input: { ftpWatts: number }) => calculateCyclingZones(input.ftpWatts),
    }),

    build_plan_skeleton: tool({
      description:
        "Build a periodized training plan skeleton from athlete profile. Returns phases, volume targets, zone tables, and testing protocols. Does NOT save anything — present the skeleton to the athlete and call plan_save only after they approve.",
      inputSchema: zodSchema(buildPlanSkeletonInputSchema),
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
        if (params.raceDate !== undefined && !isRealDateKey(params.raceDate)) {
          return {
            error: "invalid_date",
            details: `${params.raceDate} is not a real calendar date. Use YYYY-MM-DD.`,
          };
        }
        const profile: AthleteProfile = { ...params, needsExtraRecovery: false };
        const plan = buildPlanSkeleton(profile, tz);
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
              "Create a workout on intervals.icu (auto-syncs to Garmin/Wahoo). type: \"cycling\" — structured steps render as a power chart; put coaching narrative (feel, notes) in your chat reply. type: \"strength\" — free-text description (exercises, sets, reps, weight/RPE) can itself carry the coaching narrative. Past dates refused.",
            inputSchema: zodSchema(cyclingCreateWorkoutInputSchema),
            execute: async (input: CyclingCreateWorkoutInput) => {
              const dateError = validateWorkoutCreationDate(input.date, tz);
              if (dateError) return dateError;
              if (input.type === "strength") {
                if (input.name === undefined || input.description === undefined) {
                  return {
                    error: "invalid_workout",
                    details: 'strength workout requires "name" and "description"',
                  };
                }
                const result = await intervals.events.create({
                  start_date_local: `${input.date}T00:00:00`,
                  category: "WORKOUT",
                  name: input.name,
                  type: "WeightTraining",
                  ...buildCoachEventProvenance(input.date, input.name),
                  description: input.description,
                });
                if (!result.ok) return { error: result.error.kind };
                return { created: true, event: result.value };
              }
              if (input.workout === undefined) {
                return {
                  error: "invalid_workout",
                  details: 'cycling workout requires "workout"',
                };
              }
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
                ...buildCoachEventProvenance(input.date, input.workout.name),
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
