import {
  RecentRidesPanelSchema,
  type RecentRide,
  type RecentRidesPanel,
} from "@enduragent/coach-contract";
import type { CanonicalActivityReader, CanonicalActivitySummary } from "@enduragent/kernel/store";
import { utcCivilDateFromEpochSeconds } from "./civil-date.js";

const DAY_SECONDS = 86_400;
const WINDOW_DAYS = 28;
const MAX_VISIBLE_RIDES = 8;
const MAX_SCANNED_ACTIVITIES = 200;

export interface RecentRidesSource {
  readRecentRides(input: {
    readonly asOf: string;
    readonly asOfEpochSeconds: number;
  }): Promise<RecentRidesPanel>;
}

function rendererRide(activity: CanonicalActivitySummary): RecentRide {
  return {
    id: activity.id,
    subSport: activity.subSport,
    startEpochSeconds: activity.startEpochSeconds,
    timezoneOffsetSeconds: activity.timezoneOffsetSeconds,
    localDate: activity.localDate,
    elapsedSeconds: activity.elapsedSeconds,
    movingSeconds: activity.movingSeconds,
    distanceMeters: activity.distanceMeters,
  };
}

export function createRecentRidesSource(activities: CanonicalActivityReader): RecentRidesSource {
  return {
    async readRecentRides(input) {
      if (!Number.isSafeInteger(input.asOfEpochSeconds) || input.asOfEpochSeconds < 0) {
        return { kind: "unknown", reason: "not-synced" };
      }
      const firstIncludedEpochSeconds = input.asOfEpochSeconds - WINDOW_DAYS * DAY_SECONDS;
      const page = await activities.listActivities({
        start: utcCivilDateFromEpochSeconds(firstIncludedEpochSeconds - DAY_SECONDS),
        end: utcCivilDateFromEpochSeconds(input.asOfEpochSeconds + DAY_SECONDS),
        limit: MAX_SCANNED_ACTIVITIES,
      });
      const items = page.activities
        .filter(
          (activity) =>
            activity.sport === "cycling" &&
            !activity.isTransition &&
            activity.startEpochSeconds >= firstIncludedEpochSeconds &&
            activity.startEpochSeconds <= input.asOfEpochSeconds,
        )
        .slice(0, MAX_VISIBLE_RIDES)
        .map(rendererRide);
      if (items.length === 0) return { kind: "unknown", reason: "no-recent-rides" };
      return RecentRidesPanelSchema.parse({
        kind: "computed",
        asOf: input.asOf,
        windowDays: WINDOW_DAYS,
        items,
      });
    },
  };
}
