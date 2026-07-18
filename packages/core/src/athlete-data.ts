import type { ApiError, IntervalsClient } from "intervals-icu-api";
import type { ProducedLocalBundle } from "@enduragent/kernel/reference/local-bundle";
import type {
  AthleteDataReaderPort as AthleteDataReader,
  AthleteReadResult,
  CalendarEventForDelete,
  PlatformCalendarMutationsPort as PlatformCalendarMutations,
  StoredDataFreshness,
} from "@enduragent/engine/sport";

export type {
  AthleteDataReader,
  AthleteReadResult,
  CalendarEventForDelete,
  PlatformCalendarMutations,
  StoredDataFreshness,
};

export class PlatformApiError extends Error {
  readonly apiError: ApiError;
  constructor(apiError: ApiError) {
    super("platform request failed");
    this.name = "PlatformApiError";
    this.apiError = apiError;
  }
}

export class PlatformCredentialsRequiredError extends Error {
  constructor() {
    super("Calendar changes need platform credentials.");
    this.name = "PlatformCredentialsRequiredError";
  }
}

export function createMissingPlatformCalendarMutations(): PlatformCalendarMutations {
  const missing = async (): Promise<never> => { throw new PlatformCredentialsRequiredError(); };
  return Object.freeze({
    createEvent: missing,
    readEventForDelete: missing,
    deleteEvent: missing,
  });
}

async function platformValue<T>(
  request: Promise<{ ok: true; value: T } | { ok: false; error: ApiError }>,
): Promise<T> {
  const result = await request;
  if (!result.ok) throw new PlatformApiError(result.error);
  return result.value;
}

export function createPlatformAthleteDataReader(intervals: IntervalsClient): AthleteDataReader {
  return Object.freeze({
    async getAthlete() {
      return { ok: true as const, value: await platformValue(intervals.athlete.get()) };
    },
    async listWellness(input: { start: string; end?: string }) {
      return { ok: true as const, value: await platformValue(intervals.wellness.list({
        oldest: input.start,
        newest: input.end,
      })) as unknown[] };
    },
    async listActivities(input: { start: string; end?: string }) {
      return { ok: true as const, value: await platformValue(intervals.activities.list({
        oldest: input.start,
        newest: input.end,
      })) as unknown[] };
    },
    async getActivity(input: { id: string }) {
      return { ok: true as const, value: await platformValue(intervals.activities.get(input.id)) };
    },
    async getStreams(input: { id: string; keys: readonly string[] }) {
      return { ok: true as const, value: await platformValue(
        intervals.activities.getStreams(input.id, [...input.keys]),
      ) };
    },
    async listCalendar(input: { start: string; end?: string }) {
      return { ok: true as const, value: await platformValue(intervals.events.list({
        oldest: input.start,
        newest: input.end,
        category: ["WORKOUT"],
      })) as unknown[] };
    },
    freshness: () => undefined,
  });
}

export function createPlatformCalendarMutations(intervals: IntervalsClient): PlatformCalendarMutations {
  return Object.freeze({
    createEvent: (input: unknown) => platformValue(intervals.events.create(
      input as Parameters<typeof intervals.events.create>[0],
    )),
    async readEventForDelete(input: { eventId: number }) {
      const value = await platformValue(intervals.events.get(input.eventId)) as unknown as CalendarEventForDelete;
      return { id: value.id, startDateLocal: value.startDateLocal };
    },
    deleteEvent: (input: { eventId: number }) => platformValue(intervals.events.delete(input.eventId)),
  });
}

const INVALID_DATES = Object.freeze({
  ok: false as const,
  error: "invalid_input" as const,
  message: "Dates must be real YYYY-MM-DD values with start on or before end.",
});

export function isRealCivilDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map((part) => Number.parseInt(part, 10));
  const parsed = new Date(Date.UTC(y!, m! - 1, d!));
  return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m! - 1 && parsed.getUTCDate() === d;
}

function freshnessFor(snapshot: ProducedLocalBundle, clockNow: number): StoredDataFreshness | undefined {
  const capturedMs = Date.parse(snapshot.frozenNow);
  if (!Number.isFinite(capturedMs) || !Number.isSafeInteger(capturedMs) || capturedMs < 0
    || capturedMs - clockNow > 300_000) return undefined;
  const ageMs = Math.max(0, clockNow - capturedMs);
  const label = ageMs < 60_000
    ? "less than 60 seconds"
    : ageMs < 172_800_000
      ? `${Math.floor(ageMs / 60_000)} minutes`
      : `${Math.floor(ageMs / 86_400_000)} days`;
  return Object.freeze({ capturedAt: snapshot.frozenNow, ageMs, label });
}

export function formatStoreFreshness(freshness: StoredDataFreshness): string {
  return `Store data last synchronized ${freshness.label} ago (${freshness.capturedAt}).`;
}

export function createStoreAthleteDataReader(input: {
  snapshot: () => ProducedLocalBundle | undefined;
  clockNow?: () => number;
}): AthleteDataReader {
  const clockNow = input.clockNow ?? Date.now;
  const current = (): { snapshot: ProducedLocalBundle; freshness: StoredDataFreshness } | AthleteReadResult<never> => {
    const snapshot = input.snapshot();
    if (snapshot === undefined) {
      return { ok: false, error: "store_read_unavailable", message: "No complete local training-store snapshot is available." };
    }
    const freshness = freshnessFor(snapshot, clockNow());
    if (freshness === undefined) {
      return { ok: false, error: "invalid_snapshot", message: "The local training-store snapshot timestamp is invalid." };
    }
    return { snapshot, freshness };
  };
  const range = (
    snapshot: ProducedLocalBundle,
    candidate: { start: string; end?: string },
  ): { start: string; end: string } | undefined => {
    const end = candidate.end ?? snapshot.frozenNow.slice(0, 10);
    if (!isRealCivilDate(candidate.start) || !isRealCivilDate(end) || candidate.start > end) return undefined;
    return { start: candidate.start, end };
  };
  const invalidExplicitRange = (candidate: { start: string; end?: string }): boolean =>
    !isRealCivilDate(candidate.start)
    || (candidate.end !== undefined && (!isRealCivilDate(candidate.end) || candidate.start > candidate.end));

  return Object.freeze({
    async getAthlete() {
      const selected = current();
      if (!("snapshot" in selected)) return selected;
      const athlete = selected.snapshot.bundle.athlete;
      return { ok: true as const, value: {
        ...athlete,
        sportSettings: athlete?.sportSettings ?? [],
      }, freshness: selected.freshness };
    },
    async listWellness(candidate: { start: string; end?: string }) {
      if (invalidExplicitRange(candidate)) return INVALID_DATES;
      const selected = current();
      if (!("snapshot" in selected)) return selected;
      const dates = range(selected.snapshot, candidate);
      if (dates === undefined) return INVALID_DATES;
      return { ok: true as const, value: selected.snapshot.bundle.wellness.filter((row) =>
        row.id >= dates.start && row.id <= dates.end), freshness: selected.freshness };
    },
    async listActivities(candidate: { start: string; end?: string }) {
      if (invalidExplicitRange(candidate)) return INVALID_DATES;
      const selected = current();
      if (!("snapshot" in selected)) return selected;
      const dates = range(selected.snapshot, candidate);
      if (dates === undefined) return INVALID_DATES;
      return { ok: true as const, value: selected.snapshot.bundle.activities.filter((row) => {
        const date = row.start_date_local.slice(0, 10);
        return date >= dates.start && date <= dates.end;
      }), freshness: selected.freshness };
    },
    async getActivity(candidate: { id: string }) {
      const selected = current();
      if (!("snapshot" in selected)) return selected;
      const value = selected.snapshot.bundle.activities.find((row) => String(row.id) === candidate.id);
      return value === undefined
        ? { ok: false as const, error: "not_found" as const, message: "Activity was not found in the local training store." }
        : { ok: true as const, value, freshness: selected.freshness };
    },
    async getStreams(candidate: { id: string; keys: readonly string[] }) {
      const selected = current();
      if (!("snapshot" in selected)) return selected;
      const streams = selected.snapshot.bundle.streams?.[candidate.id];
      if (streams === undefined) {
        return { ok: false as const, error: "not_found" as const, message: "Activity streams were not found in the local training store." };
      }
      const requested: Record<string, unknown> = {};
      for (const key of candidate.keys) if (Object.hasOwn(streams, key)) requested[key] = streams[key];
      return { ok: true as const, value: requested, freshness: selected.freshness };
    },
    async listCalendar() {
      return { ok: false as const, error: "store_read_unavailable" as const,
        message: "Calendar reads are not available from the local training store." };
    },
    freshness() {
      const snapshot = input.snapshot();
      return snapshot === undefined ? undefined : freshnessFor(snapshot, clockNow());
    },
  });
}
