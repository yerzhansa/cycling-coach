import { AthleteStateSchema, type AthleteState } from "@enduragent/coach-contract";

const LAST_UPDATED = "1998-08-22T08:00:00.000Z";
const LAST_SYNCED = "1998-08-22T07:55:00.000Z";

type InspectionAthleteStateMetadata = Pick<
  AthleteState,
  "lastUpdated" | "freshness" | "degraded" | "lastSynced"
>;

export function createInspectionAthleteState(
  trainingContext: unknown,
  metadata: Partial<InspectionAthleteStateMetadata> = {},
): AthleteState {
  return AthleteStateSchema.parse({
    schemaVersion: "1",
    lastUpdated: metadata.lastUpdated ?? LAST_UPDATED,
    freshness: metadata.freshness ?? "fresh",
    degraded: metadata.degraded ?? false,
    lastSynced: metadata.lastSynced === undefined ? LAST_SYNCED : metadata.lastSynced,
    athleteProfile: {},
    currentStatus: {},
    derivedMetrics: {},
    recentActivities: [],
    plannedWorkouts: [],
    wellness: {},
    trainingContext,
  });
}

export const PLAN_QA_ATHLETE_STATE = createInspectionAthleteState({
  performanceProgress: { kind: "unavailable", reason: "not-synced" },
  recentRides: {
    kind: "computed",
    asOf: LAST_UPDATED,
    windowDays: 28,
    items: [
      {
        id: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        subSport: "road",
        startEpochSeconds: 903_751_200,
        timezoneOffsetSeconds: 21_600,
        localDate: "1998-08-22",
        elapsedSeconds: 7_800,
        movingSeconds: 7_500,
        distanceMeters: 61_800,
      },
    ],
  },
  trainingHistory: { kind: "unavailable", reason: "not-synced" },
  anchorZones: { kind: "unknown", reason: "missing-anchor" },
  cyclingLoad: { kind: "unknown", reason: "no-platform-load" },
  plan: { kind: "computed", asOf: LAST_UPDATED, items: [] },
  adherence: { kind: "unknown", reason: "insufficient-data" },
  wellnessTrend: { kind: "unknown", reason: "no-wellness" },
});
