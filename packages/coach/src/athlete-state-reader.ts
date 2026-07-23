import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AthleteStateSchema, type AthleteState } from "@enduragent/coach-contract";
import type { AthleteStateReaderPort } from "@enduragent/engine";
import type { CyclingFtpAnchorResolver } from "@enduragent/kernel/anchors";
import {
  ERROR_STATE_SCHEMA_VERSION,
  ErrorStateSchema,
  LATEST_SCHEMA_VERSION,
  LatestJsonSchema,
  SCHEDULER_SCHEMA_VERSION,
  SchedulerStateSchema,
} from "@enduragent/kernel/reference/schemas";
import { projectCyclingTrainingContext } from "./training-context.js";

export interface PersistedAthleteStateSource extends AthleteStateReaderPort {}

export class AthleteStateUnavailableError extends Error {}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

const ISO_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/u;

function isFiniteInstant(value: string): boolean {
  const match = ISO_INSTANT_PATTERN.exec(value);
  if (match === null) return false;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return false;
  const offsetHours = Number(match[9] ?? 0);
  const offsetMinutes = Number(match[10] ?? 0);
  if (offsetHours > 23 || offsetMinutes > 59) return false;
  const offsetSign = match[8] === "-" ? -1 : 1;
  const local = new Date(milliseconds + offsetSign * (offsetHours * 60 + offsetMinutes) * 60_000);
  return (
    local.getUTCFullYear() === Number(match[1]) &&
    local.getUTCMonth() + 1 === Number(match[2]) &&
    local.getUTCDate() === Number(match[3]) &&
    local.getUTCHours() === Number(match[4]) &&
    local.getUTCMinutes() === Number(match[5]) &&
    local.getUTCSeconds() === Number(match[6])
  );
}

export interface CreatePersistedAthleteStateSourceOptions {
  readonly dataDir: string;
  readonly cyclingFtpAnchorResolver: CyclingFtpAnchorResolver;
}

export function createPersistedAthleteStateSource(
  input: CreatePersistedAthleteStateSourceOptions,
): PersistedAthleteStateSource {
  const latestPath = join(input.dataDir, "data", "latest.json");
  const errorPath = join(input.dataDir, "data", "error_state.json");
  const schedulerPath = join(input.dataDir, "data", ".scheduler.json");
  return {
    async getAthleteState(): Promise<AthleteState> {
      const [schedulerResult] = await Promise.allSettled([readJson(schedulerPath)]);
      const [latestResult, errorResult] = await Promise.allSettled([
        readJson(latestPath),
        readJson(errorPath),
      ]);
      if (latestResult.status === "rejected") {
        throw new AthleteStateUnavailableError("No validated athlete state is available.");
      }
      const latestParsed = LatestJsonSchema.safeParse(latestResult.value);
      if (
        !latestParsed.success ||
        latestParsed.data.metadata.schema_version !== LATEST_SCHEMA_VERSION
      ) {
        throw new AthleteStateUnavailableError("No validated athlete state is available.");
      }
      const errorParsed =
        errorResult.status === "fulfilled" ? ErrorStateSchema.safeParse(errorResult.value) : null;
      const errorState =
        errorParsed?.success === true &&
        errorParsed.data.schema_version === ERROR_STATE_SCHEMA_VERSION
          ? errorParsed.data
          : null;
      const schedulerParsed =
        schedulerResult.status === "fulfilled"
          ? SchedulerStateSchema.safeParse(schedulerResult.value)
          : null;
      const schedulerState =
        schedulerParsed?.success === true &&
        schedulerParsed.data.schema_version === SCHEDULER_SCHEMA_VERSION
          ? schedulerParsed.data
          : null;
      const committedSyncAt = schedulerState?.last_sync_at ?? null;
      const lastSynced =
        committedSyncAt !== null && isFiniteInstant(committedSyncAt) ? committedSyncAt : null;
      const latest = latestParsed.data;
      const derivedMetrics = { ...latest.derived_metrics };
      delete derivedMetrics.acwr;
      delete derivedMetrics["capability.dfa_a1_profile"];
      const parsedAsOf = Date.parse(latest.metadata.last_updated);
      const asOfEpochS =
        Number.isFinite(parsedAsOf) && parsedAsOf >= 0 ? Math.floor(parsedAsOf / 1_000) : null;
      const anchor =
        asOfEpochS === null
          ? null
          : await input.cyclingFtpAnchorResolver
              .resolve({ effectiveAtEpochS: asOfEpochS, evaluatedAtEpochS: asOfEpochS })
              .catch(() => null);
      const trainingContext = projectCyclingTrainingContext({
        asOf: latest.metadata.last_updated,
        anchor,
        derivedMetrics,
        recentActivities: latest.recent_activities,
        plannedWorkouts: latest.planned_workouts,
        wellness: latest.wellness_data,
      });
      const mapped = {
        schemaVersion: latest.metadata.schema_version,
        lastUpdated: latest.metadata.last_updated,
        freshness: latest.metadata.freshness,
        degraded: errorState?.mitigation === "block_coaching",
        lastSynced,
        athleteProfile: latest.athlete_profile,
        currentStatus: latest.current_status,
        derivedMetrics,
        ...(latest.derived_metrics_meta === undefined
          ? {}
          : { derivedMetricsMeta: latest.derived_metrics_meta }),
        recentActivities: latest.recent_activities,
        plannedWorkouts: latest.planned_workouts,
        wellness: latest.wellness_data,
        trainingContext,
      };
      const state = AthleteStateSchema.safeParse(mapped);
      if (!state.success) {
        throw new AthleteStateUnavailableError(
          "Persisted athlete state does not satisfy the coaching contract.",
        );
      }
      return state.data;
    },
  };
}
