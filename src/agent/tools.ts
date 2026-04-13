import { tool, zodSchema } from "ai";
import { z } from "zod";
import {
  calculateCyclingZones,
  buildPlanSkeleton,
  assessGoalFeasibility,
  getSampleWeek,
} from "../cycling/index.js";
import type {
  AthleteProfile,
  ExperienceLevel,
  VolumeTier,
  DayOfWeek,
  RaceType,
} from "../cycling/index.js";
import type { Memory } from "./memory.js";
import type { IntervalsClient } from "intervals-icu-api";

// ============================================================================
// HELPERS
// ============================================================================

const daysEnum = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

// ============================================================================
// TOOL BUILDER
// ============================================================================

export function createTools(memory: Memory, intervals: IntervalsClient | null) {
  return {
    // ── Cycling logic tools (local, no API) ─────────────────────────────

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
        const plan = buildPlanSkeleton(profile);
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

    // ── Memory tools ─────────────────────────────────────────────────────

    memory_read: tool({
      description: "Read long-term athlete memory, today's notes, and current plan state",
      inputSchema: zodSchema(z.object({})),
      execute: async () => memory.getContext() || "No athlete data stored yet.",
    }),

    memory_write: tool({
      description: "Write to long-term memory (athlete facts, goals, preferences) or daily notes",
      inputSchema: zodSchema(
        z.object({
          type: z
            .enum(["memory", "daily"])
            .describe("'memory' for long-term facts, 'daily' for today's notes"),
          content: z.string().describe("The information to save"),
        }),
      ),
      execute: async (input: { type: "memory" | "daily"; content: string }) => {
        if (input.type === "memory") {
          memory.appendMemory(input.content);
        } else {
          memory.appendDailyNote(input.content);
        }
        return { saved: true };
      },
    }),

    plan_save: tool({
      description: "Save or update the current training plan",
      inputSchema: zodSchema(
        z.object({
          plan: z.record(z.string(), z.unknown()).describe("The training plan object to save"),
        }),
      ),
      execute: async (input: { plan: Record<string, unknown> }) => {
        memory.savePlan(input.plan);
        return { saved: true };
      },
    }),

    plan_load: tool({
      description: "Load the current active training plan",
      inputSchema: zodSchema(z.object({})),
      execute: async () => memory.loadPlan() ?? { message: "No plan saved yet." },
    }),

    // ── Intervals.icu tools ─────────────────────────────────────────────

    ...(intervals ? createIntervalsTools(intervals) : {}),
  };
}

// ============================================================================
// INTERVALS.ICU TOOLS
// ============================================================================

function createIntervalsTools(client: IntervalsClient) {
  return {
    intervals_fetch_athlete: tool({
      description:
        "Fetch athlete profile from intervals.icu (FTP, weight, max HR, sport settings, zones)",
      inputSchema: zodSchema(z.object({})),
      execute: async () => {
        const result = await client.athlete.get();
        if (!result.ok) return { error: result.error.kind };
        return result.value;
      },
    }),

    intervals_fetch_activities: tool({
      description:
        "Fetch recent activities from intervals.icu. Returns rides with TSS, IF, duration, distance.",
      inputSchema: zodSchema(
        z.object({
          oldest: z.string().describe("Oldest date (YYYY-MM-DD)"),
          newest: z.string().optional().describe("Newest date (YYYY-MM-DD)"),
        }),
      ),
      execute: async (input: { oldest: string; newest?: string }) => {
        const result = await client.activities.list({
          oldest: input.oldest,
          newest: input.newest ?? undefined,
        });
        if (!result.ok) return { error: result.error.kind };
        return result.value;
      },
    }),

    intervals_fetch_wellness: tool({
      description:
        "Fetch wellness data from intervals.icu (CTL, ATL, weight, HRV, resting HR, sleep). TSB = CTL - ATL.",
      inputSchema: zodSchema(
        z.object({
          oldest: z.string().describe("Start date (YYYY-MM-DD)"),
          newest: z.string().optional().describe("End date (YYYY-MM-DD)"),
        }),
      ),
      execute: async (input: { oldest: string; newest?: string }) => {
        const result = await client.wellness.list({
          oldest: input.oldest,
          newest: input.newest ?? undefined,
        });
        if (!result.ok) return { error: result.error.kind };
        return result.value;
      },
    }),

    intervals_create_workout: tool({
      description: "Create a workout on the intervals.icu calendar. Auto-syncs to Garmin/Wahoo.",
      inputSchema: zodSchema(
        z.object({
          date: z.string().describe("Workout date (YYYY-MM-DD)"),
          name: z.string().describe("Workout name"),
          movingTime: z.number().int().describe("Duration in seconds"),
          trainingLoad: z.number().optional().describe("Planned TSS"),
          description: z.string().optional().describe("Workout details"),
        }),
      ),
      execute: async (input: {
        date: string;
        name: string;
        movingTime: number;
        trainingLoad?: number;
        description?: string;
      }) => {
        const result = await client.events.create({
          start_date_local: `${input.date}T00:00:00`,
          category: "WORKOUT",
          name: input.name,
          type: "Ride",
          moving_time: input.movingTime,
          icu_training_load: input.trainingLoad,
          description: input.description,
        });
        if (!result.ok) return { error: result.error.kind };
        return { created: true, event: result.value };
      },
    }),
  };
}
