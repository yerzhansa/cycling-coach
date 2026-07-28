import { tool, zodSchema } from "ai";
import type { Tool } from "ai";
import { z } from "zod";
import type { ApiError, IntervalsClient } from "intervals-icu-api";
import type { IntervalsActivityType } from "../sport.js";
import { todayInTZ } from "./user-time.js";
import { downsampleStreams } from "./stream-downsample.js";
import {
  buildCoachEventProvenance,
  isCoachOwnedEvent,
} from "./event-provenance.js";
import {
  dateKeySchema,
  INTERVALS_LIST_MAX_RANGE_DAYS,
  validateListRange,
  validateWorkoutCreationDate,
} from "./date-schema.js";

export const ACTIVITY_ID_RE = /^i?\d+$/;
export const STREAM_TYPES = [
  "watts",
  "heartrate",
  "cadence",
  "time",
  "altitude",
  "distance",
  "lat",
  "lng",
  "temp",
  "smooth_grade",
] as const;

export function toTypedError(error: ApiError): {
  error: string;
  status?: number;
  message?: string;
} {
  return {
    error: error.kind,
    ...("status" in error ? { status: error.status } : {}),
    ...("message" in error ? { message: error.message } : {}),
  };
}

// intervals-icu-api's TypeScript types declare snake_case fields, but the runtime
// runs `camelCaseKeys` over every parsed response. So the types lie: at runtime we
// see `startDateLocal`, not `start_date_local`. This local type reflects reality.
export type IntervalsEventRuntime = {
  id: number;
  startDateLocal: string;
  name?: string | null;
  movingTime?: number | null;
  icuTrainingLoad?: number | null;
  category?: string | null;
  tags?: string[] | null;
  externalId?: string | null;
};

export function guardDeletableEvent(
  event: IntervalsEventRuntime,
  tz: string,
  eventId: number = event.id,
): { error: string; details: string } | undefined {
  if (event.category !== "WORKOUT") {
    return {
      error: "not_a_workout",
      details: `Event ${eventId} is category ${event.category ?? "unknown"}, not a scheduled workout. Races, notes, plans, and other calendar entries cannot be deleted by the coach.`,
    };
  }
  if (!isCoachOwnedEvent(event)) {
    return {
      error: "not_coach_created",
      details:
        "This workout was not created by this coach (no provenance marker) — it may be athlete-added, from another app, or created before provenance markers shipped. It will not be deleted; the athlete can remove it directly on intervals.icu.",
    };
  }
  const today = todayInTZ(tz);
  const eventDate = event.startDateLocal.slice(0, 10);
  if (eventDate < today) {
    return {
      error: "past_workout_protected",
      details: `Cannot delete workout dated ${eventDate} — it's before today (${today}).`,
    };
  }
  return undefined;
}

/**
 * Pure-Core intervals tools per ADR-0004 — no sport-specific config needed.
 * Wired by the binary entry point alongside the sport's own tools().
 *
 * `tz` is the athlete's IANA timezone — used so "today" in the past-workout
 * guard agrees with `event.startDateLocal` (which is in athlete-local frame),
 * not with UTC.
 */
export function createPureCoreIntervalsTools(
  intervals: IntervalsClient | null,
  tz: string = "UTC",
) {
  if (!intervals) return {};
  return {
    intervals_fetch_athlete: tool({
      description:
        "Fetch athlete profile from intervals.icu (FTP, weight, max HR, sport settings, zones)",
      inputSchema: zodSchema(z.object({})),
      execute: async () => {
        const result = await intervals.athlete.get();
        if (!result.ok) return toTypedError(result.error);
        return result.value;
      },
    }),

    intervals_fetch_wellness: tool({
      description:
        "Fetch wellness data from intervals.icu (fitness, fatigue, weight, HRV, resting HR, sleep). Form = fitness - fatigue.",
      inputSchema: zodSchema(
        z.object({
          oldest: dateKeySchema.describe("Start date (YYYY-MM-DD)"),
          newest: dateKeySchema.optional().describe("End date (YYYY-MM-DD)"),
        }),
      ),
      execute: async (input: { oldest: string; newest?: string }) => {
        const rangeError = validateListRange(
          input.oldest,
          input.newest,
          INTERVALS_LIST_MAX_RANGE_DAYS,
        );
        if (rangeError) return rangeError;
        const result = await intervals.wellness.list({
          oldest: input.oldest,
          newest: input.newest ?? undefined,
        });
        if (!result.ok) return toTypedError(result.error);
        return result.value;
      },
    }),

    intervals_fetch_activity: tool({
      description:
        "Fetch a single activity from intervals.icu by ID. Returns the full Activity " +
        "object including per-rep `icu_intervals` (lap/interval splits with avg power, " +
        "HR, time), `analyzed` flag (null while analysis still in progress), " +
        "`paired_event_id` (link to planned workout), zone times, and the headline " +
        "metrics from the list view. Use this for Tier B+ workout reviews; for " +
        "summary-only Tier A, use `intervals_fetch_activities`.",
      inputSchema: zodSchema(
        z.object({
          activityId: z
            .string()
            .regex(ACTIVITY_ID_RE)
            .describe(
              "Activity ID from intervals_fetch_activities — numeric, or i-prefixed for intervals-native activities. Pass exactly as listed.",
            ),
        }),
      ),
      execute: async (input: { activityId: string }) => {
        const result = await intervals.activities.get(input.activityId);
        if (!result.ok) return toTypedError(result.error);
        return result.value;
      },
    }),

    intervals_fetch_streams: tool({
      description:
        "Fetch raw time-series streams for an activity (watts, heartrate, cadence, " +
        "time, altitude, distance, lat, lng). Returns a downsampled object: each " +
        "requested type is binned to 10-second windows (one mean value per bin) with " +
        "a per-channel min/max/mean stats header carrying the true peaks and averages " +
        "over the full series. EXPENSIVE: a 3-hour ride is ~10,800 samples per " +
        "type even before binning. ONLY call for Tier C deep reviews (races + explicit 'deep' override). " +
        "For Tier A/B reviews, use `intervals_fetch_activities` and " +
        "`intervals_fetch_activity` instead. Default types are watts, heartrate, " +
        "cadence, time, altitude.",
      inputSchema: zodSchema(
        z.object({
          activityId: z
            .string()
            .regex(ACTIVITY_ID_RE)
            .describe(
              "Activity ID from intervals_fetch_activities — numeric, or i-prefixed for intervals-native activities. Pass exactly as listed.",
            ),
          types: z
            .array(z.enum(STREAM_TYPES))
            .optional()
            .describe(
              "Stream types to fetch. Defaults to ['watts','heartrate','cadence','time','altitude'].",
            ),
        }),
      ),
      execute: async (input: { activityId: string; types?: (typeof STREAM_TYPES)[number][] }) => {
        // Treat empty array the same as omitted — defensively handle the LLM
        // calling with `types: []` "to play it safe" instead of dropping the field.
        const types = input.types?.length
          ? input.types
          : ["watts", "heartrate", "cadence", "time", "altitude"];
        const result = await intervals.activities.getStreams(input.activityId, types);
        if (!result.ok) return toTypedError(result.error);
        return downsampleStreams(result.value as Record<string, unknown> | unknown[]);
      },
    }) as Tool,

    intervals_create_strength_workout: tool({
      description:
        "Create a strength/gym session on the intervals.icu calendar (auto-syncs to Garmin/Wahoo). The free-text description carries the whole session — exercises, sets, reps, weight/RPE — and may include coaching notes. Past dates are refused — sessions can only be created for today or later.",
      inputSchema: zodSchema(
        z.object({
          date: dateKeySchema.describe("Session date (YYYY-MM-DD)"),
          name: z
            .string()
            .min(1)
            .max(120)
            .describe("Calendar card title, e.g. 'Lower body 45min'"),
          description: z
            .string()
            .min(1)
            .max(4000)
            .describe(
              "Free-text session content — exercises, sets, reps, weight/RPE.",
            ),
        }),
      ),
      execute: async (input: { date: string; name: string; description: string }) => {
        const dateError = validateWorkoutCreationDate(input.date, tz);
        if (dateError) return dateError;
        const result = await intervals.events.create({
          start_date_local: `${input.date}T00:00:00`,
          category: "WORKOUT",
          name: input.name,
          type: "WeightTraining",
          ...buildCoachEventProvenance(input.date, `strength ${input.name}`),
          description: input.description,
        });
        if (!result.ok) return toTypedError(result.error);
        return { created: true, event: result.value };
      },
    }),

    intervals_delete_workout: tool({
      description:
        "Delete a scheduled workout from the intervals.icu calendar by event ID. " +
        "ALWAYS call intervals_list_events first, show the athlete the list, and " +
        "confirm which workout to delete before calling this. Only deletes workouts " +
        "this coach created (provenance-marked). Races, notes, plans, athlete-added " +
        "workouts, and pre-marker coach workouts are refused — tell the athlete to " +
        "remove those directly on intervals.icu. Past workouts (before today) are " +
        "protected — the tool refuses without calling the server.",
      inputSchema: zodSchema(
        z.object({
          eventId: z.number().int().describe("Event ID from intervals_list_events"),
        }),
      ),
      execute: async (input: { eventId: number }) => {
        const fetched = await intervals.events.get(input.eventId);
        if (!fetched.ok) return toTypedError(fetched.error);
        const event = fetched.value as unknown as IntervalsEventRuntime;
        const refusal = guardDeletableEvent(event, tz, input.eventId);
        if (refusal) return refusal;
        const result = await intervals.events.delete(input.eventId);
        if (!result.ok) return toTypedError(result.error);
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
          oldest: dateKeySchema.describe("Oldest date (YYYY-MM-DD)"),
          newest: dateKeySchema.optional().describe("Newest date (YYYY-MM-DD)"),
        }),
      ),
      execute: async (input: { oldest: string; newest?: string }) => {
        const rangeError = validateListRange(
          input.oldest,
          input.newest,
          INTERVALS_LIST_MAX_RANGE_DAYS,
        );
        if (rangeError) return rangeError;
        const result = await intervals.activities.list({
          oldest: input.oldest,
          newest: input.newest ?? undefined,
        });
        if (!result.ok) return toTypedError(result.error);
        return result.value;
      },
    }),

    intervals_list_events: tool({
      description:
        "List scheduled calendar workouts on intervals.icu for a date range. " +
        "Use this BEFORE deleting so you can show the athlete the list (id, date, name) " +
        "and ask which one to delete. Filters to WORKOUT category only. Each row carries " +
        "a coachCreated flag; only coach-created workouts can be deleted with " +
        "intervals_delete_workout. Pass coachCreatedOnly: true to return only " +
        "coach-created events.",
      inputSchema: zodSchema(
        z.object({
          oldest: dateKeySchema.describe("Oldest date (YYYY-MM-DD)"),
          newest: dateKeySchema.optional().describe("Newest date (YYYY-MM-DD)"),
          coachCreatedOnly: z
            .boolean()
            .optional()
            .describe("Return only events created by this coach"),
        }),
      ),
      execute: async (input: { oldest: string; newest?: string; coachCreatedOnly?: boolean }) => {
        const rangeError = validateListRange(
          input.oldest,
          input.newest,
          INTERVALS_LIST_MAX_RANGE_DAYS,
        );
        if (rangeError) return rangeError;
        const result = await intervals.events.list({
          oldest: input.oldest,
          newest: input.newest ?? undefined,
          category: ["WORKOUT"],
        });
        if (!result.ok) return toTypedError(result.error);
        const events = result.value as unknown as IntervalsEventRuntime[];
        const source = input.coachCreatedOnly === true ? events.filter(isCoachOwnedEvent) : events;
        return source.map((e) => ({
          id: e.id,
          startDateLocal: e.startDateLocal,
          name: e.name,
          movingTime: e.movingTime,
          icuTrainingLoad: e.icuTrainingLoad,
          category: e.category,
          externalId: e.externalId,
          tags: e.tags,
          coachCreated: input.coachCreatedOnly === true ? true : isCoachOwnedEvent(e),
        }));
      },
    }),
  };
}
