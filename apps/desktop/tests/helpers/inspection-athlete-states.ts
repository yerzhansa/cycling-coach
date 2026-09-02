import { AthleteStateSchema, type AthleteState } from "@enduragent/coach-contract";

const LAST_UPDATED = "1998-08-22T08:00:00.000Z";
const LAST_SYNCED = "1998-08-22T07:55:00.000Z";

export function createInspectionAthleteState(trainingContext: unknown): AthleteState {
  return AthleteStateSchema.parse({
    schemaVersion: "1",
    lastUpdated: LAST_UPDATED,
    freshness: "fresh",
    degraded: false,
    lastSynced: LAST_SYNCED,
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
