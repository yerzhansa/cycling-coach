import { describe, expect, it } from "vitest";
import type { ReferenceBundle } from "../src/reference/sync/fixture-bridge.js";
import {
  buildLatestSourceProvenance,
  deriveBundleProvenance,
} from "../src/reference/source-provenance.js";
import { computeDerivedMetrics } from "../src/reference/sync/compute-derived-metrics.js";
import { buildMetricInput } from "../src/reference/sync/fixture-bridge.js";
import { LatestJsonSchema } from "../src/reference/schemas/latest.js";
import { ActivitySchema } from "../src/reference/schemas/inputs.js";

const activity = {
  id: 1,
  start_date_local: "1998-05-09T08:00:00",
  type: "Ride",
  moving_time: 3600,
  elapsed_time: 3600,
};

function bundle(source: string | null | undefined): ReferenceBundle {
  return {
    activities: [{ ...activity, source }],
    wellness: [],
    ftpHistory: [],
  };
}

describe("Reference source provenance", () => {
  it("derives metrics from the union of actual inputs", () => {
    expect(deriveBundleProvenance(bundle("GARMIN_CONNECT"))).toEqual({
      garmin: true,
      nonGarmin: false,
      unknown: false,
    });
    expect(
      deriveBundleProvenance({
        ...bundle("POLAR"),
        wellness: [
          {
            id: "1998-05-09",
            weight: 70,
            restingHR: 48,
            hrv: 60,
            sleepSecs: 28_800,
            sleepQuality: 4,
          },
        ],
      }),
    ).toEqual({ garmin: false, nonGarmin: true, unknown: true });
    expect(deriveBundleProvenance({ activities: [], wellness: [], ftpHistory: [] })).toEqual({
      garmin: false,
      nonGarmin: false,
      unknown: false,
    });
    const malformedSource = ActivitySchema.parse({
      ...activity,
      source: { unexpected: "shape" },
    });
    expect(malformedSource.source).toBeUndefined();
    expect(
      deriveBundleProvenance({ activities: [malformedSource], wellness: [], ftpHistory: [] }),
    ).toEqual({
      garmin: false,
      nonGarmin: false,
      unknown: true,
    });
  });

  it("keeps section envelopes independent", () => {
    const input = bundle("GARMIN_CONNECT");
    const envelope = buildLatestSourceProvenance({
      bundle: input,
      athleteProfile: {},
      recentActivities: input.activities,
      wellnessData: [],
    });
    expect(envelope.recent_activities.garmin).toBe(true);
    expect(envelope.derived_metrics.garmin).toBe(true);
    expect(envelope.athlete_profile).toEqual({ garmin: false, nonGarmin: false, unknown: false });
    expect(envelope.wellness_data).toEqual({ garmin: false, nonGarmin: false, unknown: false });
  });

  it("does not treat source-like fields outside activity records as Garmin", () => {
    const input = bundle("POLAR");
    const envelope = buildLatestSourceProvenance({
      bundle: {
        ...input,
        athlete: { sportSettings: [], source: "GARMIN_CONNECT" },
        wellness: [
          {
            id: "1998-05-09",
            weight: null,
            restingHR: null,
            hrv: null,
            sleepSecs: null,
            sleepQuality: null,
            source: "GARMIN_CONNECT",
          },
        ],
      },
      athleteProfile: { source: "GARMIN_CONNECT" },
      recentActivities: input.activities,
      wellnessData: [{ source: "GARMIN_CONNECT" }],
    });

    expect(envelope.athlete_profile).toEqual({ garmin: false, nonGarmin: false, unknown: true });
    expect(envelope.wellness_data).toEqual({ garmin: false, nonGarmin: false, unknown: true });
    expect(envelope.derived_metrics).toEqual({
      garmin: false,
      nonGarmin: true,
      unknown: true,
    });
  });

  it("does not change metric formulas when only source changes", () => {
    const garmin = computeDerivedMetrics(
      buildMetricInput(bundle("GARMIN_CONNECT"), "1998-05-10T00:00:00"),
    );
    const polar = computeDerivedMetrics(buildMetricInput(bundle("POLAR"), "1998-05-10T00:00:00"));
    expect(garmin).toEqual(polar);
  });

  it("keeps valid snapshot data usable when optional provenance is malformed", () => {
    const parsed = LatestJsonSchema.parse({
      metadata: { schema_version: "4", last_updated: "1998-05-10T00:00:00Z", freshness: "fresh" },
      athlete_profile: {},
      current_status: {},
      derived_metrics: {},
      recent_activities: [{ id: 1, source: "POLAR" }],
      planned_workouts: [],
      wellness_data: {},
      source_provenance: { recent_activities: { garmin: "yes" } },
    });

    expect(parsed.recent_activities).toHaveLength(1);
    expect(parsed.source_provenance).toBeUndefined();
  });
});
