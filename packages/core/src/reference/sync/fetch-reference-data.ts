import type { IntervalsClient } from "intervals-icu-api";
import type { FetchedReference } from "./run-sync.js";
import { makeAbortableClient } from "./intervals-client-factory.js";
import { PER_REQUEST_TIMEOUT_MS } from "../freshness.js";
import { fetchLiveBundle } from "./fetch-live-bundle.js";
import { buildMetricInput } from "./fixture-bridge.js";
import { computeDerivedMetrics } from "./compute-derived-metrics.js";
import {
  runAdaptersForActivities,
  familyOf,
  type AdapterRun,
} from "../sport-adapter-dispatcher.js";
import type { ReferenceSportAdapter } from "../sport-adapter.js";
import type { IntervalsActivityType } from "../../sport.js";
import type { DerivedMetricsMeta } from "../schemas/latest.js";

/**
 * Resolve, in a single scan of `runs`, the watts-fence decision plus the
 * runs-derivable portion of the emit-time provenance tag from one representative
 * covering adapter:
 *
 *   - The representative is the power-basis covering adapter when one is present
 *     (so a mixed bundle — a duathlete's Ride+Run — keeps its power family and
 *     tags as cycling/power), else the first covering adapter.
 *   - `omitPowerFamily` is a positive pace-sport assertion: at least one
 *     activity is covered AND the representative is not power-basis. An
 *     empty-coverage bundle keeps the full family (no positive signal).
 *   - `meta` is `undefined` for an empty-coverage bundle (no adapter to
 *     attribute); otherwise it carries the representative's family +
 *     prescription anchor + anchor type. The family falls back to `"other"` for
 *     an unmapped or missing first activity type.
 *
 * The fourth meta field, `analysisBasis`, is NOT derivable here — it reads off
 * the OUTPUT of `computeDerivedMetrics` (see `readAnalysisBasis`), so the caller
 * folds it in post-compute. The `Omit` return type makes that debt explicit to
 * the compiler; keep it explicit, never widened back to the full type.
 */
export function composeProvenance(runs: readonly AdapterRun[]): {
  omitPowerFamily: boolean;
  meta: Omit<DerivedMetricsMeta, "analysisBasis"> | undefined;
} {
  if (runs.length === 0) return { omitPowerFamily: false, meta: undefined };
  const covering =
    runs.find((r) => r.adapter.zoneBasis === "power")?.adapter ?? runs[0].adapter;
  const omitPowerFamily = covering.zoneBasis !== "power";
  const firstType = covering.activityTypes[0];
  const sportFamily = firstType !== undefined ? familyOf(firstType, "other") : "other";
  return {
    omitPowerFamily,
    meta: {
      sportFamily,
      // No shipped adapter declares a 'hr' prescription anchor; only power/pace
      // are instantiated, so narrowing off the wider interface type is safe.
      prescriptionBasis: covering.zoneBasis as "power" | "pace",
      anchorType: covering.anchorType,
    },
  };
}

/**
 * Read the actual analysis substrate off the already-computed window metric —
 * never recompute it. `zone_distribution_7d.zone_basis` is the canonical
 * window-level substrate (distribution.ts emits it). Returns null when the
 * metric is absent or not an object (defensive — the omitPowerFamily fence does
 * NOT strip zone_distribution_7d today, but guard anyway). This is the substrate
 * the distribution numbers were ACTUALLY computed off; it diverges from a
 * pace-sport's `prescriptionBasis` (prescription `pace`, analysis `hr`).
 */
export function readAnalysisBasis(
  derivedMetrics: Record<string, unknown>,
): "power" | "hr" | "mixed" | null {
  const zoneDist = derivedMetrics["zone_distribution_7d"];
  return zoneDist !== null && typeof zoneDist === "object" && "zone_basis" in zoneDist
    ? ((zoneDist as { zone_basis: "power" | "hr" | "mixed" | null }).zone_basis ?? null)
    : null;
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
  const { omitPowerFamily, meta: baseMeta } = composeProvenance(runs);
  const derivedMetrics = computeDerivedMetrics(
    buildMetricInput(live.bundle, live.frozenNow),
    { omitPowerFamily },
  );
  // analysisBasis is a compute OUTPUT (read off the registry's emitted
  // zone_distribution_7d), so it joins the runs-derivable meta only after
  // compute. baseMeta is undefined exactly for an empty-coverage bundle.
  const meta = baseMeta
    ? { ...baseMeta, analysisBasis: readAnalysisBasis(derivedMetrics) }
    : undefined;

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
    ...(live.fetchErrors && live.fetchErrors.length > 0
      ? { fetch_errors: live.fetchErrors }
      : {}),
  };
}
