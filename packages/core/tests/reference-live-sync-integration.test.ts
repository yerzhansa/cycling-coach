// Integration check for the live-data bridge: the composed fetch → bridge →
// registry output (mirroring the production `fetchOnce`) must pass the Layer-1
// sync gate with no hard failures and parse against `LatestJsonSchema` — the
// shape `runSync` commits to `latest.json`. This is the "real adapter output on
// disk stays valid" guarantee behind AC3.

import { describe, expect, it } from "vitest";

import { fetchLiveBundle, type BundleFetchClient } from "../src/reference/sync/fetch-live-bundle.js";
import { buildMetricInput } from "../src/reference/sync/fixture-bridge.js";
import { computeDerivedMetrics } from "../src/reference/sync/compute-derived-metrics.js";
import { runAdaptersForActivities } from "../src/reference/sport-adapter-dispatcher.js";
import type { ReferenceSportAdapter } from "../src/reference/sport-adapter.js";
import type { IntervalsActivityType } from "../src/sport.js";
import type { FetchedReference } from "../src/reference/sync/run-sync.js";
import { gateLatestJson } from "../src/reference/validation/sync-gate.js";
import { LatestJsonSchema } from "../src/reference/schemas/latest.js";
import { METRIC_REGISTRY } from "../src/reference/metrics/registry.js";

const NOW = new Date("2026-06-09T12:00:00.000Z");

const CYCLING_ADAPTER: ReferenceSportAdapter = {
  activityTypes: ["Ride", "VirtualRide"],
  zoneBasis: "power",
  decouplingBasis: "power",
  sustainabilityAnchors: [300, 1200, 3600],
  dfaValidated: true,
};

const SPORT_TYPES: readonly IntervalsActivityType[] = ["Ride", "VirtualRide"];

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
}

function fakeClient(): BundleFetchClient {
  const activities = Array.from({ length: 5 }, (_, i) => ({
    id: 100 + i,
    startDateLocal: daysAgo(i + 1),
    type: "Ride",
    movingTime: 3600,
    elapsedTime: 3700,
    icuTrainingLoad: 80,
    averageHeartrate: 140,
    icuCtl: 50,
    icuAtl: 60,
  }));
  const wellness = Array.from({ length: 5 }, (_, i) => ({
    id: daysAgo(i + 1).slice(0, 10),
    weight: 70,
    restingHR: 50,
    hrv: 60,
    sleepSecs: 28800,
    sleepQuality: 3,
    ctl: 40,
    atl: 45,
    ctlLoad: 5,
    atlLoad: 6,
    rampRate: 1,
    sportInfo: [{ type: "Ride", eftp: 250 }],
  }));
  return {
    athlete: { get: async () => ({ ok: true, value: { sportSettings: [{ types: ["Ride"], ftp: 250, indoor_ftp: 240, lthr: 165 }] } }) },
    activities: {
      list: async () => ({ ok: true, value: activities }),
      getStreams: async () => ({ ok: true, value: { dfa_a1: [1, 0.8], heartrate: [140, 145], watts: [200, 210] } }),
    },
    wellness: { list: async () => ({ ok: true, value: wellness }) },
  };
}

/** Compose exactly as the production `fetchOnce` does. */
async function composeFetched(): Promise<FetchedReference> {
  const live = await fetchLiveBundle({ client: fakeClient(), signal: new AbortController().signal, now: NOW, throttleMs: 0 });
  runAdaptersForActivities([CYCLING_ADAPTER], SPORT_TYPES, live.bundle.activities);
  const derived_metrics = computeDerivedMetrics(buildMetricInput(live.bundle, live.frozenNow));
  return {
    latest: {
      athlete_profile: live.athleteProfile,
      current_status: {},
      derived_metrics,
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

describe("live-data bridge integration", () => {
  it("passes the Layer-1 sync gate with no hard failures", async () => {
    const fetched = await composeFetched();
    const result = gateLatestJson(fetched, null, NOW);
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("produces a latest envelope that parses against LatestJsonSchema", async () => {
    const fetched = await composeFetched();
    const onDisk = {
      metadata: { schema_version: "1", last_updated: NOW.toISOString(), freshness: "fresh" as const },
      ...fetched.latest,
    };
    expect(() => LatestJsonSchema.parse(onDisk)).not.toThrow();
  });

  it("writes a populated, full-registry derived_metrics block", async () => {
    const fetched = await composeFetched();
    const derived = fetched.latest.derived_metrics as Record<string, unknown>;
    expect(Object.keys(derived).sort()).toEqual(Object.keys(METRIC_REGISTRY).sort());
    expect(fetched.latest.recent_activities.length).toBeGreaterThan(0);
  });

  it("handles an empty bundle (zero activities/wellness): gate passes, full key-set, empty recent_activities", async () => {
    const emptyClient: BundleFetchClient = {
      athlete: { get: async () => ({ ok: true, value: {} }) },
      activities: { list: async () => ({ ok: true, value: [] }), getStreams: async () => ({ ok: true, value: [] }) },
      wellness: { list: async () => ({ ok: true, value: [] }) },
    };
    const live = await fetchLiveBundle({ client: emptyClient, signal: new AbortController().signal, now: NOW, throttleMs: 0 });
    runAdaptersForActivities([CYCLING_ADAPTER], SPORT_TYPES, live.bundle.activities);
    const derived_metrics = computeDerivedMetrics(buildMetricInput(live.bundle, live.frozenNow));
    const fetched: FetchedReference = {
      latest: {
        athlete_profile: live.athleteProfile,
        current_status: {},
        derived_metrics,
        recent_activities: live.recentActivities,
        planned_workouts: [],
        wellness_data: live.wellnessData,
      },
      history: { daily: [], weekly: [], monthly: [] },
      intervals: { by_activity: {} },
      routes: { routes: [] },
      ftp_history: { entries: [] },
    };
    expect(gateLatestJson(fetched, null, NOW).failures).toEqual([]);
    expect(Object.keys(derived_metrics).sort()).toEqual(Object.keys(METRIC_REGISTRY).sort());
    expect(live.recentActivities).toEqual([]);
  });
});
