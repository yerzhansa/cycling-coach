import { createInspectionAthleteState } from "./inspection-athlete-states.js";
import { TRAINING_CURRENT_ATHLETE_STATE } from "./training-current-athlete-state.js";

const currentTrainingContext = TRAINING_CURRENT_ATHLETE_STATE.trainingContext;
if (currentTrainingContext === undefined) throw new TypeError("expected Training context");

const AS_OF = "1998-08-30T18:00:00.000Z";

const rides = [
  {
    id: "1111111111111111111111111111111111111111111111111111111111111111",
    title: "Riverside steady",
    subSport: "road",
    startEpochSeconds: 904_464_000,
    timezoneOffsetSeconds: 21_600,
    localDate: "1998-08-30",
    ridingSeconds: 6_480,
    ridingTimeBasis: "moving",
    elapsedSeconds: 6_840,
    distanceMeters: 52_000,
    load: 72,
    averagePowerWatts: null,
    averageHeartRateBpm: 143,
    perceivedExertion: 5,
    energyKilojoules: null,
  },
  {
    id: "2222222222222222222222222222222222222222222222222222222222222222",
    title: "Recovery loop",
    subSport: "road",
    startEpochSeconds: 904_291_200,
    timezoneOffsetSeconds: 21_600,
    localDate: "1998-08-28",
    ridingSeconds: 3_300,
    ridingTimeBasis: "moving",
    elapsedSeconds: 3_480,
    distanceMeters: 25_000,
    load: 32,
    averagePowerWatts: null,
    averageHeartRateBpm: 126,
    perceivedExertion: 3,
    energyKilojoules: null,
  },
  {
    id: "3333333333333333333333333333333333333333333333333333333333333333",
    title: "Hills by feel",
    subSport: "road",
    startEpochSeconds: 904_118_400,
    timezoneOffsetSeconds: 21_600,
    localDate: "1998-08-26",
    ridingSeconds: 4_320,
    ridingTimeBasis: "moving",
    elapsedSeconds: 4_620,
    distanceMeters: 31_000,
    load: 68,
    averagePowerWatts: null,
    averageHeartRateBpm: 151,
    perceivedExertion: 7,
    energyKilojoules: null,
  },
  {
    id: "4444444444444444444444444444444444444444444444444444444444444444",
    title: "Social spin",
    subSport: "road",
    startEpochSeconds: 903_945_600,
    timezoneOffsetSeconds: 21_600,
    localDate: "1998-08-24",
    ridingSeconds: 4_500,
    ridingTimeBasis: "moving",
    elapsedSeconds: 4_980,
    distanceMeters: 48_000,
    load: 66,
    averagePowerWatts: null,
    averageHeartRateBpm: 134,
    perceivedExertion: 4,
    energyKilojoules: null,
  },
];

const previousRides = [
  {
    id: "5555555555555555555555555555555555555555555555555555555555555555",
    title: "Rolling endurance",
    subSport: "road",
    startEpochSeconds: 903_859_200,
    timezoneOffsetSeconds: 21_600,
    localDate: "1998-08-23",
    ridingSeconds: 6_420,
    ridingTimeBasis: "moving",
    elapsedSeconds: 6_840,
    distanceMeters: 67_500,
    load: 128,
    averagePowerWatts: null,
    averageHeartRateBpm: 138,
    perceivedExertion: 5,
    energyKilojoules: null,
  },
  {
    id: "6666666666666666666666666666666666666666666666666666666666666666",
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
    averagePowerWatts: null,
    averageHeartRateBpm: 124,
    perceivedExertion: 3,
    energyKilojoules: null,
  },
];

const comparisonWindow = { start: "1998-08-03", end: "1998-08-30" };

const trendBuckets = [
  {
    window: { start: "1998-07-13", end: "1998-07-19" },
    rideCount: 3,
    ridingSeconds: 12_480,
  },
  {
    window: { start: "1998-07-20", end: "1998-07-26" },
    rideCount: 3,
    ridingSeconds: 11_400,
  },
  {
    window: { start: "1998-07-27", end: "1998-08-02" },
    rideCount: 3,
    ridingSeconds: 14_100,
  },
  {
    window: { start: "1998-08-03", end: "1998-08-09" },
    rideCount: 4,
    ridingSeconds: 16_800,
  },
  {
    window: { start: "1998-08-10", end: "1998-08-16" },
    rideCount: 3,
    ridingSeconds: 14_880,
  },
  {
    window: { start: "1998-08-17", end: "1998-08-23" },
    rideCount: 2,
    ridingSeconds: 9_660,
  },
];

export const TRAINING_NO_POWER_ATHLETE_STATE = createInspectionAthleteState(
  {
    ...currentTrainingContext,
    performanceProgress: { kind: "unavailable", reason: "insufficient-data" },
    recentRides: {
      kind: "computed",
      asOf: AS_OF,
      windowDays: 28,
      items: [...rides, ...previousRides].map((ride) => ({
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
      kind: "computed",
      asOf: AS_OF,
      calendarTimeZone: "Asia/Almaty",
      displayMode: "current",
      coverage: {
        kind: "contiguous",
        start: "1998-05-01",
        through: "1998-08-30",
        committedAt: "1998-08-30T17:55:00.000Z",
      },
      anchorWeek: {
        id: "anchor",
        window: { start: "1998-08-24", end: "1998-08-30" },
        calendarState: "open",
        coverage: { kind: "complete" },
        totals: {
          rideCount: { kind: "computed", value: 4 },
          ridingSeconds: { kind: "computed", value: 18_600 },
          distanceMeters: { kind: "computed", value: 156_000 },
          load: { kind: "computed", value: 238 },
        },
        rides: {
          count: { kind: "exact", value: 4 },
          items: rides,
          truncated: false,
        },
        trend: {
          kind: "computed",
          buckets: trendBuckets,
        },
        callout: {
          kind: "longest-ride-28d",
          rideId: rides[0].id,
          durationSeconds: rides[0].ridingSeconds,
          window: comparisonWindow,
          comparisonRideCount:
            rides.filter(
              (ride) =>
                ride.localDate >= comparisonWindow.start && ride.localDate <= comparisonWindow.end,
            ).length +
            trendBuckets
              .filter(
                (bucket) =>
                  bucket.window.start >= comparisonWindow.start &&
                  bucket.window.end <= comparisonWindow.end,
              )
              .reduce((sum, bucket) => sum + bucket.rideCount, 0),
        },
      },
      previousWeek: {
        id: "previous",
        window: { start: "1998-08-17", end: "1998-08-23" },
        calendarState: "closed",
        coverage: { kind: "complete" },
        totals: {
          rideCount: { kind: "computed", value: 2 },
          ridingSeconds: { kind: "computed", value: 9_660 },
          distanceMeters: { kind: "computed", value: 93_500 },
          load: { kind: "computed", value: 159 },
        },
        rides: {
          count: { kind: "exact", value: 2 },
          items: previousRides,
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
            ...trendBuckets.slice(0, -1),
          ],
        },
        callout: null,
      },
    },
    cyclingLoad: {
      kind: "computed",
      asOf: AS_OF,
      source: "intervals.icu",
      windowDays: 7,
      value: 238,
      activityCount: 4,
      missingLoadCount: 0,
    },
  },
  {
    lastUpdated: AS_OF,
    lastSynced: "1998-08-30T17:55:00.000Z",
  },
);
