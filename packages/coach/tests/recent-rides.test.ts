import { describe, expect, it, vi } from "vitest";
import type { CanonicalActivityReader, CanonicalActivitySummary } from "@enduragent/kernel/store";
import { createRecentRidesSource } from "../src/recent-rides.js";

const AS_OF = "2026-07-18T00:00:00.000Z";
const AS_OF_EPOCH_SECONDS = Date.parse(AS_OF) / 1_000;

function activity(
  index: number,
  overrides: Partial<CanonicalActivitySummary> = {},
): CanonicalActivitySummary {
  return {
    id: index.toString(16).padStart(64, "0"),
    workoutId: (index + 100).toString(16).padStart(64, "0"),
    sessionSequence: 0,
    isMultisport: false,
    sport: "cycling",
    subSport: "road",
    isTransition: false,
    startEpochSeconds: AS_OF_EPOCH_SECONDS - index * 3_600,
    timezoneOffsetSeconds: 21_600,
    localDate: "2026-07-18",
    elapsedSeconds: 3_700,
    timerSeconds: 3_600,
    movingSeconds: 3_500,
    distanceMeters: 40_200,
    ...overrides,
  };
}

function reader(rows: readonly CanonicalActivitySummary[]) {
  const listActivities = vi.fn<CanonicalActivityReader["listActivities"]>(async () => ({
    activities: rows,
    nextCursor: null,
  }));
  const value: CanonicalActivityReader = {
    listActivities,
    async getActivity() {
      return undefined;
    },
    async getStreams() {
      return undefined;
    },
  };
  return { value, listActivities };
}

describe("recent rides source", () => {
  it("returns only the eight newest bounded cycling sessions and strips trusted-only fields", async () => {
    const rows = [
      activity(1),
      activity(2, { sport: "running" }),
      activity(3, { isTransition: true }),
      ...Array.from({ length: 9 }, (_, index) => activity(index + 4)),
      activity(20, {
        startEpochSeconds: AS_OF_EPOCH_SECONDS - 28 * 86_400 - 1,
        localDate: "2026-06-19",
      }),
      activity(21, { startEpochSeconds: AS_OF_EPOCH_SECONDS + 1 }),
    ];
    const canonical = reader(rows);

    const result = await createRecentRidesSource(canonical.value).readRecentRides({
      asOf: AS_OF,
      asOfEpochSeconds: AS_OF_EPOCH_SECONDS,
    });

    expect(canonical.listActivities).toHaveBeenCalledWith({
      start: "2026-06-19",
      end: "2026-07-19",
      limit: 200,
    });
    expect(result).toMatchObject({ kind: "computed", asOf: AS_OF, windowDays: 28 });
    if (result.kind !== "computed") throw new Error("expected computed rides");
    expect(result.items.map(({ id }) => id)).toEqual(
      [1, 4, 5, 6, 7, 8, 9, 10].map((index) => index.toString(16).padStart(64, "0")),
    );
    expect(Object.keys(result.items[0]!)).toEqual([
      "id",
      "subSport",
      "startEpochSeconds",
      "timezoneOffsetSeconds",
      "localDate",
      "elapsedSeconds",
      "movingSeconds",
      "distanceMeters",
    ]);
  });

  it("includes the exact 28-day boundary and reports an explicit empty state", async () => {
    const boundary = activity(1, {
      startEpochSeconds: AS_OF_EPOCH_SECONDS - 28 * 86_400,
      localDate: "2026-06-20",
    });
    await expect(
      createRecentRidesSource(reader([boundary]).value).readRecentRides({
        asOf: AS_OF,
        asOfEpochSeconds: AS_OF_EPOCH_SECONDS,
      }),
    ).resolves.toMatchObject({ kind: "computed", items: [{ id: boundary.id }] });
    await expect(
      createRecentRidesSource(reader([]).value).readRecentRides({
        asOf: AS_OF,
        asOfEpochSeconds: AS_OF_EPOCH_SECONDS,
      }),
    ).resolves.toEqual({ kind: "unknown", reason: "no-recent-rides" });
  });

  it("does not query the store for an invalid as-of instant", async () => {
    const canonical = reader([]);
    await expect(
      createRecentRidesSource(canonical.value).readRecentRides({
        asOf: AS_OF,
        asOfEpochSeconds: -1,
      }),
    ).resolves.toEqual({ kind: "unknown", reason: "not-synced" });
    expect(canonical.listActivities).not.toHaveBeenCalled();
  });
});
