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
} from "@enduragent/kernel/reference/schemas";
import { projectCyclingTrainingContext } from "./training-context.js";

export interface PersistedAthleteStateSource extends AthleteStateReaderPort {}

export class AthleteStateUnavailableError extends Error {}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
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
  return {
    async getAthleteState(): Promise<AthleteState> {
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
        lastSynced: latest.metadata.last_updated,
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
