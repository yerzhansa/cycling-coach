import type { IntervalsClient } from "intervals-icu-api";
import type { FetchedReference } from "./run-sync.js";
import { makeAbortableClient } from "./intervals-client-factory.js";
import { PER_REQUEST_TIMEOUT_MS } from "../freshness.js";
import { fetchLiveBundle } from "./fetch-live-bundle.js";
import { buildMetricInput } from "./fixture-bridge.js";
import { computeDerivedMetrics } from "./compute-derived-metrics.js";
import {
  runAdaptersForActivities,
  type AdapterRun,
} from "../sport-adapter-dispatcher.js";
import type { ReferenceSportAdapter } from "../sport-adapter.js";
import type { IntervalsActivityType } from "../../sport.js";
import { SPORT_FAMILIES } from "../metrics/sport-families.js";

interface DerivedMetricsMeta {
  readonly sportFamily: string;
  readonly basis: "power" | "pace" | "hr";
  readonly anchorType: "critical-speed" | "ftp";
}

/**
 * Derive the emit-time provenance tag from the covering adapters. Prefers a
 * power-basis adapter when one is present so a mixed bundle (a duathlete's
 * Ride+Run) tags as its kept power family, matching the omission decision;
 * otherwise the first covering adapter wins. Returns `undefined` for an
 * empty-coverage bundle (no adapter to attribute), leaving the optional tag off.
 */
function deriveMeta(runs: readonly AdapterRun[]): DerivedMetricsMeta | undefined {
  if (runs.length === 0) return undefined;
  const covering =
    runs.find((r) => r.adapter.zoneBasis === "power")?.adapter ?? runs[0].adapter;
  const firstType = covering.activityTypes[0];
  const sportFamily =
    firstType !== undefined && Object.hasOwn(SPORT_FAMILIES, firstType)
      ? SPORT_FAMILIES[firstType]
      : "other";
  return { sportFamily, basis: covering.zoneBasis, anchorType: covering.anchorType };
}

/**
 * Production fetcher. Pulls the live intervals.icu bundle (athlete profile,
 * trailing activities/wellness, bounded HRV/power streams), bridges it to the
 * metric-compute input shape, fans the live activities out to their covering
 * sport adapters, and runs the metric registry so `latest.json` carries real
 * `recent_activities` + computed `derived_metrics`. Constructs a per-runSync
 * `IntervalsClient` (per ADR-0011) so the orchestrator's outer
 * `AbortController` propagates into in-flight requests; the stream loop is
 * additionally abort-aware so a slow account cannot exhaust the sync budget.
 *
 * Out of scope (separate deferred tickets): the per-window power/HR/
 * sustainability curve fetch (the curve-delta capability metrics reproduce
 * their null blocks until it lands). The
 * `history`/`intervals`/`routes`/`ftp_history` retention cache files keep their
 * empty stubs — they are populated by their own retention pipeline, not here.
 */
export function makeProductionFetcher(deps: {
  apiKey: string;
  athleteId?: string;
  adapters: readonly ReferenceSportAdapter[];
  sportTypes: readonly IntervalsActivityType[];
}): (signal: AbortSignal) => Promise<FetchedReference> {
  return async (signal) => {
    const client = makeAbortableClient({
      apiKey: deps.apiKey,
      athleteId: deps.athleteId,
      signal,
      perRequestMs: PER_REQUEST_TIMEOUT_MS,
    });
    return await fetchOnce(client, signal, deps.adapters, deps.sportTypes);
  };
}

async function fetchOnce(
  client: IntervalsClient,
  signal: AbortSignal,
  adapters: readonly ReferenceSportAdapter[],
  sportTypes: readonly IntervalsActivityType[],
): Promise<FetchedReference> {
  const live = await fetchLiveBundle({ client, signal, now: new Date() });
  const runs: readonly AdapterRun[] = runAdaptersForActivities(
    adapters,
    sportTypes,
    live.bundle.activities,
  );
  // Omit the power family only on a positive pace-sport assertion: at least one
  // activity is covered AND no covering adapter is power-basis. An
  // empty-coverage bundle keeps the full family (no positive signal).
  const coveredPowerBasis = runs.some((r) => r.adapter.zoneBasis === "power");
  const omitPowerFamily = runs.length > 0 && !coveredPowerBasis;
  const derivedMetrics = computeDerivedMetrics(
    buildMetricInput(live.bundle, live.frozenNow),
    { omitPowerFamily },
  );
  const meta = deriveMeta(runs);

  return {
    latest: {
      athlete_profile: live.athleteProfile,
      current_status: {},
      derived_metrics: derivedMetrics,
      // Sibling of `derived_metrics`, NEVER a key inside it — the parity gate's
      // key-union deepCompare runs over the map only, so the tag must stay out.
      ...(meta ? { derived_metrics_meta: meta } : {}),
      recent_activities: live.recentActivities,
      planned_workouts: [],
      wellness_data: live.wellnessData,
    },
    history: { daily: [], weekly: [], monthly: [] },
    intervals: { by_activity: {} },
    routes: { routes: [] },
    ftp_history: { entries: [] },
  };
}
