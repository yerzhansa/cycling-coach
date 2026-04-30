import { tool, zodSchema } from "ai";
import { z } from "zod";
import type { IntervalsClient } from "intervals-icu-api";
import type { IntervalsActivityType } from "../sport.js";

// intervals-icu-api's TypeScript types declare snake_case fields, but the runtime
// runs `camelCaseKeys` over every parsed response. So the types lie: at runtime we
// see `startDateLocal`, not `start_date_local`. This local type reflects reality.
type IntervalsEventRuntime = {
  id: number;
  startDateLocal: string;
  name?: string | null;
  movingTime?: number | null;
  icuTrainingLoad?: number | null;
};

/**
 * Pure-Core intervals tools per ADR-0004 — no sport-specific config needed.
 * Wired by the binary entry point alongside the sport's own tools().
 */
export function createPureCoreIntervalsTools(intervals: IntervalsClient | null) {
  if (!intervals) return {};
  return {
    intervals_fetch_athlete: tool({
      description:
        "Fetch athlete profile from intervals.icu (FTP, weight, max HR, sport settings, zones)",
      inputSchema: zodSchema(z.object({})),
      execute: async () => {
        const result = await intervals.athlete.get();
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
        const result = await intervals.wellness.list({
          oldest: input.oldest,
          newest: input.newest ?? undefined,
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
        "today) are protected — the tool refuses without calling the server.",
      inputSchema: zodSchema(
        z.object({
          eventId: z.number().int().describe("Event ID from intervals_list_events"),
        }),
      ),
      execute: async (input: { eventId: number }) => {
        const fetched = await intervals.events.get(input.eventId);
        if (!fetched.ok) return { error: fetched.error.kind };
        const event = fetched.value as unknown as IntervalsEventRuntime;
        const today = new Date().toISOString().split("T")[0];
        const eventDate = event.startDateLocal.slice(0, 10);
        if (eventDate < today) {
          return {
            error: "past_workout_protected",
            details: `Cannot delete workout dated ${eventDate} — it's before today (${today}).`,
          };
        }
        const result = await intervals.events.delete(input.eventId);
        if (!result.ok) return { error: result.error.kind };
        return { deleted: true };
      },
    }),
  };
}

/**
 * Core-with-sport-config intervals tools per ADR-0004 — Core implementation,
 * sport-supplied activity-type filter at construction time.
 */
export function createCoreToolsWithSportConfig(
  intervals: IntervalsClient | null,
  activityTypes: readonly IntervalsActivityType[],
) {
  if (!intervals) return {};
  // The activityTypes array is reserved for future filtering of the API responses
  // (e.g., when intervals.icu adds a server-side filter); today we keep the same
  // list/fetch shape and let the LLM disambiguate via descriptions. Embedding
  // the param in the closure keeps the contract stable across sports.
  void activityTypes;
  return {
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
        const result = await intervals.activities.list({
          oldest: input.oldest,
          newest: input.newest ?? undefined,
        });
        if (!result.ok) return { error: result.error.kind };
        return result.value;
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
        const result = await intervals.events.list({
          oldest: input.oldest,
          newest: input.newest ?? undefined,
          category: ["WORKOUT"],
        });
        if (!result.ok) return { error: result.error.kind };
        return (result.value as unknown as IntervalsEventRuntime[]).map((e) => ({
          id: e.id,
          startDateLocal: e.startDateLocal,
          name: e.name,
          movingTime: e.movingTime,
          icuTrainingLoad: e.icuTrainingLoad,
        }));
      },
    }),
  };
}
