import { createInspectionAthleteState } from "./inspection-athlete-states.js";
import { TRAINING_CURRENT_ATHLETE_STATE } from "./training-current-athlete-state.js";

const currentTrainingContext = TRAINING_CURRENT_ATHLETE_STATE.trainingContext;
if (currentTrainingContext === undefined) throw new TypeError("expected Training context");

const AS_OF = "1998-08-30T18:00:00.000Z";
const RECORDED_THROUGH = "1998-08-28";

const recordedRides = [
  {
    id: "9999999999999999999999999999999999999999999999999999999999999999",
    title: "Park tempo",
    subSport: "road",
    startEpochSeconds: 904_291_200,
    timezoneOffsetSeconds: 21_600,
    localDate: "1998-08-28",
    ridingSeconds: 4_680,
    ridingTimeBasis: "moving",
    elapsedSeconds: 4_860,
    distanceMeters: 38_000,
    load: 74,
    averagePowerWatts: 203,
    averageHeartRateBpm: 147,
    perceivedExertion: null,
    energyKilojoules: 949,
  },
  {
    id: "adadadadadadadadadadadadadadadadadadadadadadadadadadadadadadadad",
    title: "Country endurance",
    subSport: "road",
    startEpochSeconds: 904_118_400,
    timezoneOffsetSeconds: 21_600,
    localDate: "1998-08-26",
    ridingSeconds: 6_420,
    ridingTimeBasis: "moving",
    elapsedSeconds: 6_600,
    distanceMeters: 54_000,
    load: 86,
    averagePowerWatts: 177,
    averageHeartRateBpm: 136,
    perceivedExertion: null,
    energyKilojoules: 1_137,
  },
];

export const TRAINING_INCOMPLETE_ATHLETE_STATE = createInspectionAthleteState(
  {
    ...currentTrainingContext,
    performanceProgress: { kind: "unavailable", reason: "temporary-failure" },
    recentRides: {
      kind: "computed",
      asOf: AS_OF,
      windowDays: 28,
      items: recordedRides.map((ride) => ({
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
        kind: "incomplete",
        provenStart: "1998-05-01",
        provenThrough: RECORDED_THROUGH,
        observedThrough: RECORDED_THROUGH,
        committedAt: "1998-08-28T17:55:00.000Z",
        reason: "source-degraded",
      },
      anchorWeek: {
        id: "anchor",
        window: { start: "1998-08-24", end: "1998-08-30" },
        calendarState: "open",
        coverage: {
          kind: "incomplete",
          recordedThrough: RECORDED_THROUGH,
          reason: "source-degraded",
        },
        totals: {
          rideCount: { kind: "partial", value: 2, reason: "incomplete-coverage" },
          ridingSeconds: { kind: "partial", value: 11_100, reason: "incomplete-coverage" },
          distanceMeters: { kind: "partial", value: 92_000, reason: "incomplete-coverage" },
          load: { kind: "partial", value: 160, reason: "incomplete-coverage" },
        },
        rides: {
          count: { kind: "at-least", value: 2 },
          items: recordedRides,
          truncated: true,
        },
        trend: { kind: "unavailable", reason: "incomplete-source" },
        callout: null,
      },
      previousWeek: {
        id: "previous",
        window: { start: "1998-08-17", end: "1998-08-23" },
        calendarState: "closed",
        coverage: { kind: "complete" },
        totals: {
          rideCount: { kind: "computed", value: 0 },
          ridingSeconds: { kind: "computed", value: 0 },
          distanceMeters: { kind: "computed", value: 0 },
          load: { kind: "computed", value: 0 },
        },
        rides: {
          count: { kind: "exact", value: 0 },
          items: [],
          truncated: false,
        },
        trend: { kind: "unavailable", reason: "incomplete-source" },
        callout: null,
      },
    },
    cyclingLoad: { kind: "unknown", reason: "source-restricted" },
  },
  {
    lastUpdated: AS_OF,
    freshness: "flag",
    degraded: true,
    lastSynced: "1998-08-28T17:55:00.000Z",
  },
);
