import { tool, zodSchema } from "ai";
import { z } from "zod";
import {
  calculateCyclingZones,
  buildPlanSkeleton,
  assessGoalFeasibility,
  getSampleWeek,
  serializeIntervalsWorkout,
  intervalsWorkoutInputSchema,
  InvalidWorkoutError,
} from "../cycling/index.js";
import type {
  AthleteProfile,
  ExperienceLevel,
  VolumeTier,
  DayOfWeek,
  RaceType,
  IntervalsWorkoutInput,
} from "../cycling/index.js";
import type { Memory } from "./memory.js";
import type { IntervalsClient } from "intervals-icu-api";

// ============================================================================
// HELPERS
// ============================================================================

const daysEnum = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

// ============================================================================
// SHARED TOOL FACTORIES
// ============================================================================

export function createMemoryReadTool(memory: Memory) {
  return tool({
    description: "Read long-term athlete memory, today's notes, and current plan state",
    inputSchema: zodSchema(z.object({})),
    execute: async () => memory.getContext() || "No athlete data stored yet.",
  });
}

// ============================================================================
// TOOL BUILDER
// ============================================================================

export function createTools(
  memory: Memory,
  intervals: IntervalsClient | null,
  intervalsAuth: { apiKey: string; athleteId: string } | null,
) {
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

    memory_read: createMemoryReadTool(memory),

    memory_write: tool({
      description:
        "Write to long-term memory (replaces section content) or daily notes. " +
        "Use sections to organize athlete data: profile (FTP, weight, age, experience), " +
        "schedule (training days, availability), goals (target events, FTP targets), " +
        "equipment (bikes, trainer, power meter), health (injuries, HR, sleep), " +
        "preferences (indoor/outdoor, coaching style), notes (anything else).",
      inputSchema: zodSchema(
        z.object({
          type: z
            .enum(["memory", "daily"])
            .describe("'memory' for long-term facts, 'daily' for today's notes"),
          section: z
            .enum(["profile", "schedule", "goals", "equipment", "health", "preferences", "notes"])
            .optional()
            .describe("Memory section to write to (required when type='memory'). Replaces the section content."),
          content: z.string().describe("The information to save"),
        }),
      ),
      execute: async (input: { type: "memory" | "daily"; section?: string; content: string }) => {
        if (input.type === "memory") {
          memory.writeSection(input.section ?? "notes", input.content);
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

    ...(intervals && intervalsAuth ? createIntervalsTools(intervals, intervalsAuth) : {}),
  };
}

// ============================================================================
// INTERVALS.ICU TOOLS
// ============================================================================

function createIntervalsTools(
  client: IntervalsClient,
  auth: { apiKey: string; athleteId: string },
) {
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
        "Fetch recent activities from intervals.icu. Returns rides with load, intensity, duration, distance.",
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
        "Fetch wellness data from intervals.icu (fitness, fatigue, weight, HRV, resting HR, sleep). Form = fitness - fatigue.",
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
        const result = await client.events.create({
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

    intervals_list_events: tool({
      description:
        "List scheduled calendar workouts on intervals.icu for a date range. " +
        "Use this BEFORE deleting so you can show the athlete the list (id, date, name) " +
        "and ask which one to delete. Filters to WORKOUT category only.",
      inputSchema: zodSchema(
        z.object({
          oldest: z.string().describe("Oldest date (YYYY-MM-DD)"),
          newest: z.string().optional().describe("Newest date (YYYY-MM-DD)"),
        }),
      ),
      execute: async (input: { oldest: string; newest?: string }) => {
        const result = await client.events.list({
          oldest: input.oldest,
          newest: input.newest ?? undefined,
          category: ["WORKOUT"],
        });
        if (!result.ok) return { error: result.error.kind };
        return result.value;
      },
    }),

    intervals_delete_workout: tool({
      description:
        "Delete a scheduled workout from the intervals.icu calendar by event ID. " +
        "ALWAYS call intervals_list_events first, show the athlete the list, and " +
        "confirm which workout to delete before calling this. Past workouts (before " +
        "today) are protected — the server will reject the delete.",
      inputSchema: zodSchema(
        z.object({
          eventId: z.number().int().describe("Event ID from intervals_list_events"),
        }),
      ),
      execute: async (input: { eventId: number }) => {
        const today = new Date().toISOString().split("T")[0];
        const url =
          `https://intervals.icu/api/v1/athlete/${auth.athleteId}` +
          `/events/${input.eventId}?notBefore=${today}`;
        const basic = Buffer.from(`API_KEY:${auth.apiKey}`).toString("base64");
        const res = await fetch(url, {
          method: "DELETE",
          headers: { Authorization: `Basic ${basic}` },
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          return { error: `http_${res.status}`, message: body || res.statusText };
        }
        return { deleted: true };
      },
    }),
  };
}
