// Live intervals.icu fetch for the Reference sync. Pulls the athlete profile,
// a trailing window of activities + wellness, derives a cycling FTP history,
// and (best-effort, bounded) the per-activity HRV/power streams the DFA-α1 and
// per-session capability metrics consume. Returns a `ReferenceBundle` the
// fixture bridge turns into the metric-compute input shape.
//
// ADR-0012: every sync path into Reference MUST pass real rows through the
// rename anti-corruption layer between API parse and any downstream consumer.
// This module is that boundary for the production path — `renameTpFieldsOn*`
// per row, then `assertNoTpKeysRemain` over the assembled rows.
//
// Robustness: per-row rename/parse and per-activity stream fetches are
// best-effort (a bad row or a failed stream is skipped with a warning, never
// fails the whole sync). The streams loop is bounded (recent cycling rides
// only, capped) and abort-aware so a slow account cannot consume the whole
// `SYNC_OPERATION_TIMEOUT_MS` budget.

import { snakeCaseKeys } from "intervals-icu-api";

import {
  AthleteSchema,
  ActivityStreamsSchema,
  type Activity,
  type ActivityStreams,
  type AthleteSettings,
  type FtpHistoryPoint,
  type WellnessDay,
} from "../schemas/inputs.js";
import {
  assertNoTpKeysRemain,
  parseRenamedActivity,
  parseRenamedWellnessRow,
  renameTpFieldsOnActivity,
  renameTpFieldsOnWellnessRow,
  type RenameSummary,
} from "./rename-tp-fields.js";
import { LATEST_RETENTION_DAYS } from "../freshness.js";
import type { ReferenceBundle } from "./fixture-bridge.js";

/** Trailing window pulled for metric computation (covers the widest metric
 *  window — the 42-day sustainability look-back — with margin). */
export const FETCH_WINDOW_DAYS = 84;
/** Only fetch per-activity streams for rides this recent. DFA-α1's trailing
 *  aggregate reads the last few sufficient sessions, so a short window keeps
 *  the request count bounded without starving the metric. */
export const STREAM_WINDOW_DAYS = 21;
/** Hard cap on per-activity stream fetches per sync, regardless of window. */
export const MAX_STREAM_ACTIVITIES = 12;
const STREAM_THROTTLE_MS = 250;
/** Wall-clock budget for the whole stream phase. Streams are best-effort, so we
 *  stop fetching once this elapses rather than letting a slow account push the
 *  sync toward the outer SYNC_OPERATION_TIMEOUT_MS (which would abort with an
 *  empty-failure and no useful cache). */
const STREAM_PHASE_BUDGET_MS = 60_000;

/** Per-second channels requested per activity. `dfa_a1` + `artifacts` are the
 *  HRV channels the DFA-α1 block reads; `watts`/`heartrate` feed the per-session
 *  capability blocks. `time` is requested for alignment and rides through. */
export const STREAM_TYPES: readonly string[] = [
  "time",
  "watts",
  "heartrate",
  "dfa_a1",
  "artifacts",
];

/** DFA-α1 is upstream-validated for cycling only; stream fetches target these
 *  types (the cycling adapter's `activityTypes`). */
const STREAM_SPORT_TYPES: ReadonlySet<string> = new Set(["Ride", "VirtualRide"]);

/** Cycling sport types whose `sportInfo.eftp` seeds the FTP history series. */
const CYCLING_TYPES: ReadonlySet<string> = new Set([
  "Ride",
  "VirtualRide",
  "GravelRide",
  "MountainBikeRide",
  "EBikeRide",
  "EMountainBikeRide",
  "TrackRide",
  "Cyclocross",
  "Handcycle",
]);

type FetchResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** Structural subset of `IntervalsClient` the bundle fetch needs — narrow so
 *  tests can inject a fake without standing up the whole client. */
export interface BundleFetchClient {
  readonly athlete: { get(): Promise<FetchResult<unknown>> };
  readonly activities: {
    list(query: { oldest: string; newest?: string }): Promise<FetchResult<unknown[]>>;
    getStreams(activityId: string, types: string[]): Promise<FetchResult<unknown>>;
  };
  readonly wellness: {
    list(query: { oldest?: string; newest?: string }): Promise<FetchResult<unknown[]>>;
  };
}

export interface LiveFetchResult {
  /** Raw athlete object — cached verbatim as `latest.athlete_profile`. */
  readonly athleteProfile: unknown;
  /** Trailing 7-day renamed activities for the `latest.recent_activities` cache. */
  readonly recentActivities: readonly Activity[];
  /** Renamed wellness rows for the `latest.wellness_data` cache. */
  readonly wellnessData: readonly WellnessDay[];
  /** Full-window inputs for metric computation. */
  readonly bundle: ReferenceBundle;
  /** Sync wall-clock as an ISO string — the metric date-window anchor. */
  readonly frozenNow: string;
}

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// Zone-less local-time ISO (YYYY-MM-DDThh:mm:ss). The metric date-window math
// compares this anchor's date prefix against activity `start_date_local` values,
// which intervals.icu emits in the athlete's local time with no zone. A UTC
// `toISOString()` here would shift the anchor's calendar date near midnight and
// drop/include a day's activities at the window edge; the naive-local form
// mirrors the oracle's `datetime.now()` convention so the windows line up.
function naiveLocalIso(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
    `T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
  );
}

// intervals.icu's streams endpoint returns an array of channel objects
// (`[{type, data}, …]`); the lib also camelCases response keys (so `dfa_a1`
// becomes `dfaA1` on the object form). Normalize both into the channel-keyed
// shape the metrics + ActivityStreamsSchema consume (`{dfa_a1, watts, …}`).
export function normalizeStreams(value: unknown): unknown {
  if (Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    for (const el of value) {
      if (
        el !== null &&
        typeof el === "object" &&
        typeof (el as Record<string, unknown>).type === "string" &&
        Array.isArray((el as Record<string, unknown>).data)
      ) {
        out[(el as Record<string, unknown>).type as string] = (el as Record<string, unknown>).data;
      }
    }
    return out;
  }
  if (value !== null && typeof value === "object") {
    return snakeCaseKeys(value);
  }
  return value;
}

function isCyclingStreamType(type: unknown): boolean {
  return typeof type === "string" && STREAM_SPORT_TYPES.has(type);
}

/** Sparse cycling FTP series from per-day `sportInfo.eftp` — one point per
 *  change. intervals.icu has no public FTP-history endpoint, so the series is
 *  synthesized from wellness sportInfo exactly as the fixture builder does. */
export function deriveFtpHistory(
  wellness: readonly WellnessDay[],
): FtpHistoryPoint[] {
  const points: FtpHistoryPoint[] = [];
  let lastFtp: number | null = null;
  const sorted = [...wellness].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const day of sorted) {
    const sportInfo =
      (day as { sportInfo?: Array<Record<string, unknown>> | null }).sportInfo ?? [];
    let cyclingEftp: number | null = null;
    for (const si of sportInfo) {
      if (
        typeof si.type === "string" &&
        CYCLING_TYPES.has(si.type) &&
        typeof si.eftp === "number" &&
        Number.isFinite(si.eftp)
      ) {
        cyclingEftp = Math.round(si.eftp);
        break;
      }
    }
    if (cyclingEftp === null || cyclingEftp === lastFtp) continue;
    points.push({ date: String(day.id), ftp: cyclingEftp, source: "estimate" });
    lastFtp = cyclingEftp;
  }
  return points;
}

function extractAthleteSettings(profile: unknown): AthleteSettings | undefined {
  if (typeof profile !== "object" || profile === null) return undefined;
  const sportSettings = (profile as Record<string, unknown>).sportSettings;
  if (!Array.isArray(sportSettings)) return undefined;
  // The profile rides through the lib's camelCasing (indoor_ftp -> indoorFtp);
  // reverse it so AthleteSchema's snake_case fields resolve.
  const parsed = AthleteSchema.safeParse({ sportSettings: snakeCaseKeys(sportSettings) });
  return parsed.success ? parsed.data : undefined;
}

interface LiveFetchDeps {
  readonly client: BundleFetchClient;
  readonly signal: AbortSignal;
  readonly now: Date;
  /** Override the inter-request throttle (tests pass 0). */
  readonly throttleMs?: number;
  /** Sink for non-fatal warnings; defaults to console.warn. */
  readonly log?: (msg: string) => void;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Fetch + assemble the live Reference bundle. Throws only on a hard
 * precondition failure (activities list unreachable) or a surviving
 * TP-trademarked key (the anti-corruption contract); every other degradation
 * is best-effort and logged.
 */
export async function fetchLiveBundle(deps: LiveFetchDeps): Promise<LiveFetchResult> {
  const { client, signal, now } = deps;
  const log = deps.log ?? ((m: string) => console.warn(m));
  const throttleMs = deps.throttleMs ?? STREAM_THROTTLE_MS;
  const frozenNow = naiveLocalIso(now);

  const newest = ymd(now);
  const oldest = ymd(new Date(now.getTime() - FETCH_WINDOW_DAYS * 24 * 60 * 60 * 1000));

  const athleteResult = await client.athlete.get();
  if (!athleteResult.ok) log(`Reference: athlete.get failed: ${String(athleteResult.error)}`);
  const athleteProfile = athleteResult.ok ? athleteResult.value : {};

  const actResult = await client.activities.list({ oldest, newest });
  if (!actResult.ok) {
    throw new Error(`activities.list failed: ${String(actResult.error)}`);
  }
  // The lib auto-camelCases activity responses; ActivitySchema requires
  // snake_case (start_date_local, icu_training_load, …). Reverse it here only —
  // wellness already ships in the camelCase mixed shape the schema agrees on. A
  // non-array body (ok:true but malformed) is treated as empty, not a crash.
  let rawActivities: Array<Record<string, unknown>> = [];
  if (Array.isArray(actResult.value)) {
    rawActivities = snakeCaseKeys(actResult.value) as Array<Record<string, unknown>>;
  } else {
    log("Reference: activities.list returned a non-array body; treating as empty");
  }

  const wellResult = await client.wellness.list({ oldest, newest });
  if (!wellResult.ok) log(`Reference: wellness.list failed: ${String(wellResult.error)}`);
  const rawWellness: Array<Record<string, unknown>> =
    wellResult.ok && Array.isArray(wellResult.value)
      ? (wellResult.value as Array<Record<string, unknown>>)
      : [];

  const actSummary: RenameSummary = { skippedNonNumeric: {} };
  const wellSummary: RenameSummary = { skippedNonNumeric: {} };

  const activities: Activity[] = [];
  for (const row of rawActivities) {
    try {
      activities.push(parseRenamedActivity(renameTpFieldsOnActivity(row, actSummary)));
    } catch (err) {
      log(`Reference: skipped malformed activity row: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const wellness: WellnessDay[] = [];
  for (const row of rawWellness) {
    try {
      wellness.push(parseRenamedWellnessRow(renameTpFieldsOnWellnessRow(row, wellSummary)));
    } catch (err) {
      log(`Reference: skipped malformed wellness row: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ADR-0012 defense-in-depth: no TP-trademarked key may survive rename.
  assertNoTpKeysRemain({ activities, wellness });

  const streams = await fetchStreams(client, activities, signal, now, throttleMs, log);

  const ftpHistory = deriveFtpHistory(wellness);
  const athlete = extractAthleteSettings(athleteProfile);

  const bundle: ReferenceBundle = {
    activities,
    wellness,
    ftpHistory,
    ...(Object.keys(streams).length > 0 ? { streams } : {}),
    ...(athlete !== undefined ? { athlete } : {}),
  };

  const retentionCutoffMs = now.getTime() - LATEST_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const recentActivities = activities.filter((a) => {
    if (typeof a.start_date_local !== "string") return false;
    const ms = Date.parse(a.start_date_local);
    return Number.isFinite(ms) && ms >= retentionCutoffMs;
  });

  return { athleteProfile, recentActivities, wellnessData: wellness, bundle, frozenNow };
}

async function fetchStreams(
  client: BundleFetchClient,
  activities: readonly Activity[],
  signal: AbortSignal,
  now: Date,
  throttleMs: number,
  log: (msg: string) => void,
): Promise<Record<string, ActivityStreams>> {
  const streamCutoffMs = now.getTime() - STREAM_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const seen = new Set<string>();
  const candidates = activities
    .filter((a) => isCyclingStreamType(a.type) && typeof a.start_date_local === "string")
    .filter((a) => {
      const ms = Date.parse(a.start_date_local);
      return Number.isFinite(ms) && ms >= streamCutoffMs;
    })
    .sort((a, b) => Date.parse(b.start_date_local) - Date.parse(a.start_date_local))
    .filter((a) => {
      // Collapse duplicate ids (the sort keeps the newest first), so a repeated
      // id can't double-fetch or mis-join the DFA profile.
      const id = String(a.id);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .slice(0, MAX_STREAM_ACTIVITIES);

  const deadline = Date.now() + STREAM_PHASE_BUDGET_MS;
  const out: Record<string, ActivityStreams> = {};
  for (const activity of candidates) {
    if (signal.aborted || Date.now() > deadline) break;
    const id = String(activity.id);
    let result: FetchResult<unknown>;
    try {
      result = await client.activities.getStreams(id, [...STREAM_TYPES]);
    } catch (err) {
      log(`Reference: streams fetch threw for an activity: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (!result.ok) {
      log(`Reference: streams fetch failed for an activity: ${String(result.error)}`);
      continue;
    }
    const parsed = ActivityStreamsSchema.safeParse(normalizeStreams(result.value));
    if (!parsed.success) {
      log(`Reference: streams shape rejected for an activity: ${parsed.error.message}`);
      continue;
    }
    out[id] = parsed.data;
    await sleep(throttleMs, signal);
  }
  return out;
}
