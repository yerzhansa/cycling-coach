import { createInspectionAthleteState } from "./inspection-athlete-states.js";
import { TRAINING_CURRENT_ATHLETE_STATE } from "./training-current-athlete-state.js";

const currentTrainingContext = TRAINING_CURRENT_ATHLETE_STATE.trainingContext;
if (currentTrainingContext === undefined) throw new TypeError("expected Training context");

const LAST_GOOD_AS_OF = "1998-08-23T18:00:00.000Z";
const FAILED_AT = "1998-08-30T18:00:00.000Z";

const rides = [
  {
    id: "bdbdbdbdbdbdbdbdbdbdbdbdbdbdbdbdbdbdbdbdbdbdbdbdbdbdbdbdbdbdbdbd",
    title: "Rolling endurance",
    subSport: "road",
    startEpochSeconds: 903_859_200,
    timezoneOffsetSeconds: 21_600,
    localDate: "1998-08-23",
    ridingSeconds: 7_920,
    ridingTimeBasis: "moving",
    elapsedSeconds: 8_340,
    distanceMeters: 67_500,
    load: 128,
    averagePowerWatts: 176,
    averageHeartRateBpm: 138,
    perceivedExertion: null,
    energyKilojoules: 1_394,
  },
  {
    id: "cececececececececececececececececececececececececececececececece",
    title: "Easy road spin",
    subSport: "road",
    startEpochSeconds: 903_600_000,
    timezoneOffsetSeconds: 21_600,
    localDate: "1998-08-20",
    ridingSeconds: 3_240,
    ridingTimeBasis: "moving",
    elapsedSeconds: 3_420,
    distanceMeters: 26_000,
    load: 31,
    averagePowerWatts: 151,
    averageHeartRateBpm: 124,
    perceivedExertion: null,
    energyKilojoules: 489,
  },
];

export const TRAINING_STALE_ATHLETE_STATE = createInspectionAthleteState(
  {
    ...currentTrainingContext,
    performanceProgress: { kind: "unavailable", reason: "refresh-failed" },
    recentRides: {
      kind: "computed",
      asOf: LAST_GOOD_AS_OF,
      windowDays: 28,
      items: rides.map((ride) => ({
        id: ride.id,
        subSport: ride.subSport,
        startEpochSeconds: ride.startEpochSeconds,
        timezoneOffsetSeconds: ride.timezoneOffsetSeconds,
        localDate: ride.localDate,
        elapsedSeconds: ride.elapsedSeconds,
        movingSeconds: ride.ridingSeconds,
        distanceMeters: ride.distanceMeters,
      })),
    },
    trainingHistory: {
      kind: "stale",
      failedAt: FAILED_AT,
      reason: "temporary-failure",
      lastGood: {
        kind: "computed",
        asOf: LAST_GOOD_AS_OF,
        calendarTimeZone: "Asia/Almaty",
        displayMode: "last-recorded",
        coverage: {
          kind: "contiguous",
          start: "1998-05-01",
          through: "1998-08-23",
          committedAt: "1998-08-23T17:55:00.000Z",
        },
        anchorWeek: {
          id: "anchor",
          window: { start: "1998-08-17", end: "1998-08-23" },
          calendarState: "closed",
          coverage: { kind: "complete" },
          totals: {
            rideCount: { kind: "computed", value: 2 },
            ridingSeconds: { kind: "computed", value: 11_160 },
            distanceMeters: { kind: "computed", value: 93_500 },
            load: { kind: "computed", value: 159 },
          },
          rides: {
            count: { kind: "exact", value: 2 },
            items: rides,
            truncated: false,
          },
          trend: {
            kind: "computed",
            buckets: [
              {
                window: { start: "1998-07-06", end: "1998-07-12" },
                rideCount: 3,
                ridingSeconds: 14_760,
              },
              {
                window: { start: "1998-07-13", end: "1998-07-19" },
                rideCount: 4,
                ridingSeconds: 16_500,
              },
              {
                window: { start: "1998-07-20", end: "1998-07-26" },
                rideCount: 3,
                ridingSeconds: 13_680,
              },
              {
                window: { start: "1998-07-27", end: "1998-08-02" },
                rideCount: 4,
                ridingSeconds: 15_600,
              },
              {
                window: { start: "1998-08-03", end: "1998-08-09" },
                rideCount: 4,
                ridingSeconds: 18_600,
              },
              {
                window: { start: "1998-08-10", end: "1998-08-16" },
                rideCount: 3,
                ridingSeconds: 11_700,
              },
            ],
          },
          callout: null,
        },
        previousWeek: null,
      },
    },
    cyclingLoad: {
      kind: "computed",
      asOf: LAST_GOOD_AS_OF,
      source: "intervals.icu",
      windowDays: 7,
      value: 159,
      activityCount: 2,
      missingLoadCount: 0,
    },
  },
  {
    lastUpdated: FAILED_AT,
    freshness: "stale",
    degraded: true,
    lastSynced: "1998-08-23T17:55:00.000Z",
  },
);
