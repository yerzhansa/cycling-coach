import { createInspectionAthleteState } from "./inspection-athlete-states.js";
import { TRAINING_CURRENT_ATHLETE_STATE } from "./training-current-athlete-state.js";

const currentTrainingContext = TRAINING_CURRENT_ATHLETE_STATE.trainingContext;
if (currentTrainingContext === undefined) throw new TypeError("expected Training context");

const AS_OF = "1998-08-30T18:00:00.000Z";

const anchorRide = {
  id: "7878787878787878787878787878787878787878787878787878787878787878",
  title: "Canal ride",
  subSport: "road",
  startEpochSeconds: 904_377_600,
  timezoneOffsetSeconds: 21_600,
  localDate: "1998-08-29",
  ridingSeconds: 5_340,
  ridingTimeBasis: "moving",
  elapsedSeconds: 5_520,
  distanceMeters: 41_000,
  load: 78,
  averagePowerWatts: 218,
  averageHeartRateBpm: 146,
  perceivedExertion: null,
  energyKilojoules: 1_082,
};

const previousRide = {
  id: "8888888888888888888888888888888888888888888888888888888888888888",
  title: "Indoor return",
  subSport: "indoor_cycling",
  startEpochSeconds: 903_427_200,
  timezoneOffsetSeconds: 21_600,
  localDate: "1998-08-18",
  ridingSeconds: 4_080,
  ridingTimeBasis: "moving",
  elapsedSeconds: 4_080,
  distanceMeters: 30_000,
  load: 54,
  averagePowerWatts: 184,
  averageHeartRateBpm: 137,
  perceivedExertion: null,
  energyKilojoules: 751,
};

export const TRAINING_LIMITED_ATHLETE_STATE = createInspectionAthleteState(
  {
    ...currentTrainingContext,
    performanceProgress: { kind: "unavailable", reason: "insufficient-data" },
    recentRides: {
      kind: "computed",
      asOf: AS_OF,
      windowDays: 28,
      items: [anchorRide, previousRide].map((ride) => ({
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
        start: "1998-08-17",
        through: "1998-08-30",
        committedAt: "1998-08-30T17:55:00.000Z",
      },
      anchorWeek: {
        id: "anchor",
        window: { start: "1998-08-24", end: "1998-08-30" },
        calendarState: "open",
        coverage: { kind: "complete" },
        totals: {
          rideCount: { kind: "computed", value: 1 },
          ridingSeconds: { kind: "computed", value: 5_340 },
          distanceMeters: { kind: "computed", value: 41_000 },
          load: { kind: "computed", value: 78 },
        },
        rides: {
          count: { kind: "exact", value: 1 },
          items: [anchorRide],
          truncated: false,
        },
        trend: { kind: "unavailable", reason: "limited-history" },
        callout: null,
      },
      previousWeek: {
        id: "previous",
        window: { start: "1998-08-17", end: "1998-08-23" },
        calendarState: "closed",
        coverage: { kind: "complete" },
        totals: {
          rideCount: { kind: "computed", value: 1 },
          ridingSeconds: { kind: "computed", value: 4_080 },
          distanceMeters: { kind: "computed", value: 30_000 },
          load: { kind: "computed", value: 54 },
        },
        rides: {
          count: { kind: "exact", value: 1 },
          items: [previousRide],
          truncated: false,
        },
        trend: { kind: "unavailable", reason: "limited-history" },
        callout: null,
      },
    },
    cyclingLoad: {
      kind: "computed",
      asOf: AS_OF,
      source: "intervals.icu",
      windowDays: 7,
      value: 78,
      activityCount: 1,
      missingLoadCount: 0,
    },
  },
  {
    lastUpdated: AS_OF,
    lastSynced: "1998-08-30T17:55:00.000Z",
  },
);
