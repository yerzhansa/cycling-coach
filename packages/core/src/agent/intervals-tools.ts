import { tool, zodSchema } from "ai";
import { z } from "zod";
import type { ApiError, IntervalsClient } from "intervals-icu-api";
import type { IntervalsActivityType } from "../sport.js";
import { todayInTZ } from "./user-time.js";
import { downsampleStreams } from "./stream-downsample.js";
import {
  formatStoreFreshness,
  createPlatformAthleteDataReader,
  createPlatformCalendarMutations,
  PlatformApiError,
  PlatformCredentialsRequiredError,
  type AthleteDataReader,
  type AthleteReadResult,
  type PlatformCalendarMutations,
} from "../athlete-data.js";

function toTypedError(error: ApiError): { error: string; status?: number; message?: string } {
  return {
    error: error.kind,
    ...("status" in error ? { status: error.status } : {}),
    ...("message" in error ? { message: error.message } : {}),
  };
}

function readResult<T>(result: AthleteReadResult<T>): T | { error: string; message: string }
  | { data: T; freshness: string } {
  if (!result.ok) return { error: result.error, message: result.message };
  if (result.freshness !== undefined) {
    return { data: result.value, freshness: formatStoreFreshness(result.freshness) };
  }
  return result.value;
}

function platformFailure(error: unknown): ReturnType<typeof toTypedError> {
  if (error instanceof PlatformApiError) return toTypedError(error.apiError);
  throw error;
}

const CREDENTIALS_REQUIRED = Object.freeze({
  error: "platform_credentials_required",
  message: "Calendar changes need platform credentials.",
});

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
 *
 * `tz` is the athlete's IANA timezone — used so "today" in the past-workout
 * guard agrees with `event.startDateLocal` (which is in athlete-local frame),
 * not with UTC.
 */
export function createPureCoreIntervalsTools(
  intervals: IntervalsClient | null,
  tz: string = "UTC",
  athleteData?: AthleteDataReader,
  calendarMutations?: PlatformCalendarMutations,
) {
  const selectedReader = athleteData ?? (intervals === null ? undefined : createPlatformAthleteDataReader(intervals));
  const selectedMutations = calendarMutations ?? (intervals === null ? undefined : createPlatformCalendarMutations(intervals));
  if (!selectedReader && !selectedMutations) return {};
  return {
    ...(selectedReader ? { intervals_fetch_athlete: tool({
      description:
        "Fetch athlete profile from intervals.icu (FTP, weight, max HR, sport settings, zones)",
      inputSchema: zodSchema(z.object({})),
      execute: async () => {
        try { return readResult(await selectedReader.getAthlete()); }
        catch (error) { return platformFailure(error); }
      },
    }) } : {}),

    ...(selectedReader ? { intervals_fetch_wellness: tool({
      description:
        "Fetch wellness data from intervals.icu (fitness, fatigue, weight, HRV, resting HR, sleep). Form = fitness - fatigue.",
      inputSchema: zodSchema(
        z.object({
          oldest: z.string().describe("Start date (YYYY-MM-DD)"),
          newest: z.string().optional().describe("End date (YYYY-MM-DD)"),
        }),
      ),
      execute: async (input: { oldest: string; newest?: string }) => {
        try { return readResult(await selectedReader.listWellness({
          start: input.oldest,
          ...(input.newest === undefined ? {} : { end: input.newest }),
        })); }
        catch (error) { return platformFailure(error); }
      },
    }) } : {}),

    ...(selectedReader ? { intervals_fetch_activity: tool({
      description:
        "Fetch a single activity from intervals.icu by ID. Returns the full Activity " +
        "object including per-rep `icu_intervals` (lap/interval splits with avg power, " +
        "HR, time), `analyzed` flag (null while analysis still in progress), " +
        "`paired_event_id` (link to planned workout), zone times, and the headline " +
        "metrics from the list view. Use this for Tier B+ workout reviews; for " +
        "summary-only Tier A, use `intervals_fetch_activities`.",
      inputSchema: zodSchema(
        z.object({
          activityId: z.number().int().describe("Activity ID from intervals_fetch_activities"),
        }),
      ),
      execute: async (input: { activityId: number }) => {
        try { return readResult(await selectedReader.getActivity({ id: String(input.activityId) })); }
        catch (error) { return platformFailure(error); }
      },
    }) } : {}),

    ...(selectedReader ? { intervals_fetch_streams: tool({
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
          activityId: z.number().int().describe("Activity ID"),
          types: z
            .array(z.string())
            .optional()
            .describe(
              "Stream types to fetch. Defaults to ['watts','heartrate','cadence','time','altitude']. " +
                "Other valid types: distance, lat, lng, temp, smooth_grade.",
            ),
        }),
      ),
      execute: async (input: { activityId: number; types?: string[] }) => {
        // Treat empty array the same as omitted — defensively handle the LLM
        // calling with `types: []` "to play it safe" instead of dropping the field.
        const types = input.types?.length
          ? input.types
          : ["watts", "heartrate", "cadence", "time", "altitude"];
        try {
          const result = await selectedReader.getStreams({ id: String(input.activityId), keys: types });
          if (!result.ok) return readResult(result);
          const value = downsampleStreams(result.value as Record<string, unknown> | unknown[]);
          return result.freshness === undefined ? value
            : { data: value, freshness: formatStoreFreshness(result.freshness) };
        } catch (error) { return platformFailure(error); }
      },
    }) } : {}),

    ...(selectedMutations ? { intervals_delete_workout: tool({
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
        try {
          const event = await selectedMutations.readEventForDelete({ eventId: input.eventId });
          const today = todayInTZ(tz);
          const eventDate = event.startDateLocal.slice(0, 10);
          if (eventDate < today) {
            return {
              error: "past_workout_protected",
              details: `Cannot delete workout dated ${eventDate} — it's before today (${today}).`,
            };
          }
          await selectedMutations.deleteEvent({ eventId: input.eventId });
          return { deleted: true };
        } catch (error) {
          if (error instanceof PlatformCredentialsRequiredError) return CREDENTIALS_REQUIRED;
          return platformFailure(error);
        }
      },
    }) } : {}),
  };
}

/**
 * Core-with-sport-config intervals tools per ADR-0004 — Core implementation,
 * sport-supplied activity-type filter at construction time.
 */
export function createCoreToolsWithSportConfig(
  intervals: IntervalsClient | null,
  activityTypes: readonly IntervalsActivityType[],
  athleteData?: AthleteDataReader,
) {
  const selectedReader = athleteData ?? (intervals === null ? undefined : createPlatformAthleteDataReader(intervals));
  if (!selectedReader) return {};
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
        try { return readResult(await selectedReader.listActivities({
          start: input.oldest,
          ...(input.newest === undefined ? {} : { end: input.newest }),
        })); }
        catch (error) { return platformFailure(error); }
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
        try {
          const result = await selectedReader.listCalendar({ start: input.oldest,
            ...(input.newest === undefined ? {} : { end: input.newest }) });
          if (!result.ok) return readResult(result);
          const value = (result.value as IntervalsEventRuntime[]).map((e) => ({
            id: e.id,
            startDateLocal: e.startDateLocal,
            name: e.name,
            movingTime: e.movingTime,
            icuTrainingLoad: e.icuTrainingLoad,
          }));
          return result.freshness === undefined ? value
            : { data: value, freshness: formatStoreFreshness(result.freshness) };
        } catch (error) { return platformFailure(error); }
      },
    }),
  };
}
