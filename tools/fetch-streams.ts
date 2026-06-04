// Dev-time fetcher for the per-activity raw streams and per-athlete
// power/HR/sustainability curve sets needed to assemble the Reference layer's
// curve- and stream-driven fixtures. Reads the secondary intervals.icu account
// (INTERVALS_ATHLETE_ID_2 / INTERVALS_API_KEY_2) and caches each raw response
// under `referenceDataDir("cycling-coach")/streams/`. The snapshot harness
// never reads this cache — it is operator scratch for fixture authoring only.
//
// Usage (run from repo root for module resolution; credentials live in .env):
//   pnpm exec tsx --env-file=.env tools/fetch-streams.ts [--days N] [--oldest YYYY-MM-DD] [--newest YYYY-MM-DD] [--limit N]
//
// The activities listing endpoint 422s without oldest/newest, so a window is
// always sent: --oldest/--newest override the default trailing --days window.
// --limit caps the number of activities processed (smoke runs).

import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { IntervalsClient, snakeCaseKeys } from "intervals-icu-api";

import { atomicWriteJson } from "../packages/core/src/io/atomic-write-json.js";
import { referenceDataDir } from "../packages/core/src/reference/paths.js";

const BINARY_NAME = "cycling-coach";
const INTERVALS_BASE_URL = "https://intervals.icu/api/v1";

const DEFAULT_WINDOW_DAYS = 42;
const THROTTLE_MS = 250;

// Per-activity stream channels. dfa_a1 + artifacts are requested explicitly so
// the cache records their absence for accounts that don't surface them (the
// AlphaHRV recording fields); the endpoint simply omits absent channels.
export const STREAM_TYPES: readonly string[] = [
  "time",
  "watts",
  "heartrate",
  "dfa_a1",
  "artifacts",
];

const CYCLING_SPORT_TYPES: readonly string[] = ["Ride", "VirtualRide"];

export interface Window {
  oldest: string;
  newest: string;
}

export interface CliArgs {
  days: number;
  oldest?: string;
  newest?: string;
  limit?: number;
}

type StreamFetcher = (
  activityId: string,
  types: readonly string[],
) => Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }>;

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function streamCachePath(cacheRoot: string, activityId: string): string {
  return join(cacheRoot, `${activityId}.json`);
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { days: DEFAULT_WINDOW_DAYS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) {
        throw new Error(`flag ${arg} requires a value`);
      }
      i++;
      return v;
    };
    switch (arg) {
      case "--days":
        args.days = Number(next());
        break;
      case "--oldest":
        args.oldest = next();
        break;
      case "--newest":
        args.newest = next();
        break;
      case "--limit":
        args.limit = Number(next());
        break;
      default:
        throw new Error(`unknown flag: ${arg}`);
    }
  }
  return args;
}

export function resolveWindow(args: CliArgs): Window {
  const newest = args.newest ?? ymd(new Date());
  const oldest = args.oldest ?? ymd(new Date(Date.now() - args.days * 24 * 60 * 60 * 1000));
  return { oldest, newest };
}

export function basicAuthHeader(apiKey: string): string {
  // Same convention the intervals.icu client uses: HTTP Basic with the literal
  // username "API_KEY" and the key as the password.
  const encoded = Buffer.from(`API_KEY:${apiKey}`).toString("base64");
  return `Basic ${encoded}`;
}

async function rawGet(
  athleteId: string,
  apiKey: string,
  endpoint: string,
  query: Record<string, string>,
): Promise<unknown> {
  const url = new URL(`${INTERVALS_BASE_URL}/athlete/${athleteId}/${endpoint}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    headers: {
      Authorization: basicAuthHeader(apiKey),
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`${endpoint} → HTTP ${response.status}`);
  }
  return response.json();
}

async function writeCache(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await atomicWriteJson(path, value);
}

/**
 * Cache each activity's streams under `cacheRoot`, skipping any activity whose
 * file already exists (idempotent re-runs). `getStreams` is injected so the
 * loop is exercised without a live network in tests. Returns the fetched /
 * skipped counts.
 */
export async function cacheActivityStreams(
  cacheRoot: string,
  activityIds: readonly string[],
  getStreams: StreamFetcher,
  options?: { throttleMs?: number; log?: (msg: string) => void },
): Promise<{ fetched: number; skipped: number }> {
  const throttleMs = options?.throttleMs ?? THROTTLE_MS;
  const log = options?.log ?? ((msg: string) => console.error(msg));
  let fetched = 0;
  let skipped = 0;
  for (const id of activityIds) {
    const cachePath = streamCachePath(cacheRoot, id);
    if (existsSync(cachePath)) {
      skipped++;
      continue;
    }
    const result = await getStreams(id, STREAM_TYPES);
    if (!result.ok) {
      log(`  streams for activity failed: ${result.error}`);
      continue;
    }
    await writeCache(cachePath, result.value);
    fetched++;
    if (throttleMs > 0) await sleep(throttleMs);
  }
  return { fetched, skipped };
}

async function main(): Promise<void> {
  const athleteId = process.env.INTERVALS_ATHLETE_ID_2;
  const apiKey = process.env.INTERVALS_API_KEY_2;
  if (!athleteId || !apiKey) {
    console.error(
      "Missing credentials. Set INTERVALS_ATHLETE_ID_2 and INTERVALS_API_KEY_2 " +
        "(e.g. run with `pnpm exec tsx --env-file=.env tools/fetch-streams.ts`). " +
        "These are the secondary-account vars, distinct from INTERVALS_API_KEY.",
    );
    process.exit(1);
  }

  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    console.error(
      "usage: tsx tools/fetch-streams.ts [--days N] [--oldest YYYY-MM-DD] [--newest YYYY-MM-DD] [--limit N]",
    );
    process.exit(2);
    return;
  }

  const { oldest, newest } = resolveWindow(args);
  const cacheRoot = join(referenceDataDir(BINARY_NAME), "streams");
  const curvesRoot = join(cacheRoot, "curves");

  const client = new IntervalsClient({
    apiKey,
    athleteId,
    retry: { maxAttempts: 1 },
  });

  console.error(`Listing activities ${oldest} → ${newest}…`);
  const listResult = await client.activities.list({ oldest, newest });
  if (!listResult.ok) {
    console.error("activities.list failed:", listResult.error);
    process.exit(2);
    return;
  }
  let activities = snakeCaseKeys(listResult.value) as Array<Record<string, unknown>>;
  if (args.limit !== undefined) {
    activities = activities.slice(0, args.limit);
  }
  console.error(`  → ${activities.length} activities in scope`);

  const activityIds = activities.map((a) => String(a.id));
  const streamCounts = await cacheActivityStreams(cacheRoot, activityIds, (id, types) =>
    client.activities.getStreams(id, [...types]),
  );
  console.error(
    `Streams: ${streamCounts.fetched} fetched, ${streamCounts.skipped} cached (skipped)`,
  );

  await fetchCurves(athleteId, apiKey, curvesRoot, { oldest, newest });
}

async function fetchCurves(
  athleteId: string,
  apiKey: string,
  curvesRoot: string,
  window: Window,
): Promise<void> {
  const curvesParam = `r.${window.oldest}.${window.newest}`;

  const jobs: Array<{ name: string; endpoint: string; query: Record<string, string> }> = [
    {
      name: "power-curves-ride",
      endpoint: "power-curves",
      query: { type: "Ride", curves: curvesParam },
    },
    {
      name: "hr-curves",
      endpoint: "hr-curves",
      query: { curves: curvesParam },
    },
  ];

  // Per-sport-type sustainability curve sets — one power + one hr fetch per
  // cycling sport type, mirroring the upstream's sport-filtered fetch loop.
  for (const type of CYCLING_SPORT_TYPES) {
    jobs.push({
      name: `sustainability-power-${type}`,
      endpoint: "power-curves",
      query: { type, curves: curvesParam },
    });
    jobs.push({
      name: `sustainability-hr-${type}`,
      endpoint: "hr-curves",
      query: { type, curves: curvesParam },
    });
  }

  let fetched = 0;
  let skipped = 0;
  for (const job of jobs) {
    const cachePath = join(curvesRoot, `${job.name}.json`);
    if (existsSync(cachePath)) {
      skipped++;
      continue;
    }
    try {
      const data = await rawGet(athleteId, apiKey, job.endpoint, job.query);
      await writeCache(cachePath, data);
      fetched++;
    } catch (err) {
      console.error(`  curve fetch ${job.name} failed: ${(err as Error).message}`);
    }
    await sleep(THROTTLE_MS);
  }
  console.error(`Curves: ${fetched} fetched, ${skipped} cached (skipped)`);
  console.error(`Cache root: ${curvesRoot.replace(/\/curves$/, "")}`);
}

const isCli =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;

if (isCli) {
  main().catch((err) => {
    console.error("fatal:", err);
    process.exit(2);
  });
}
