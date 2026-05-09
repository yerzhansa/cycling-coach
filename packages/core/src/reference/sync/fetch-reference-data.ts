// Adapted from CrankAddict/section-11 (MIT, 2026); see NOTICE.md.

import type { IntervalsClient } from "intervals-icu-api";
import type { FetchedReference } from "./run-sync.js";
import { makeAbortableClient } from "./intervals-client-factory.js";
import { PER_REQUEST_TIMEOUT_MS } from "../freshness.js";

/**
 * Wave 1b production fetcher. Wave 2 / F11 fleshes out per-metric population;
 * Wave 1b just proves the orchestration writes a parseable cache for the
 * scheduler-and-snapshot debug surface to read. Constructs a per-runSync
 * `IntervalsClient` (per ADR-0011) so the orchestrator's outer
 * `AbortController` propagates into in-flight requests.
 */
export function makeProductionFetcher(deps: {
  apiKey: string;
  athleteId?: string;
}): (signal: AbortSignal) => Promise<FetchedReference> {
  return async (signal) => {
    const client = makeAbortableClient({
      apiKey: deps.apiKey,
      athleteId: deps.athleteId,
      signal,
      perRequestMs: PER_REQUEST_TIMEOUT_MS,
    });
    return await fetchOnce(client);
  };
}

async function fetchOnce(client: IntervalsClient): Promise<FetchedReference> {
  const athleteResult = await client.athlete.get();
  const athlete = athleteResult.ok ? athleteResult.value : {};

  return {
    latest: {
      athlete_profile: athlete,
      current_status: {},
      derived_metrics: {},
      recent_activities: [],
      planned_workouts: [],
      wellness_data: {},
    },
    history: { daily: [], weekly: [], monthly: [] },
    intervals: { by_activity: {} },
    routes: { routes: [] },
    ftp_history: { entries: [] },
  };
}
