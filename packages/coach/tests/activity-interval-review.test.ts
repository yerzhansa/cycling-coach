import type { CanonicalActivityDetail } from "@enduragent/kernel/store";
import type { ActivityIntervals } from "intervals-icu-api";
import { describe, expect, it, vi } from "vitest";
import {
  createIntervalReviewAnalyzer,
  createProviderActivityIntervalReader,
  projectProviderActivityIntervals,
} from "../src/activity-interval-review.js";

const ACTIVITY_ID = "a".repeat(64);
const REVISION = "b".repeat(64);

const activity: CanonicalActivityDetail = {
  id: ACTIVITY_ID,
  workoutId: "c".repeat(64),
  sessionSequence: 0,
  isMultisport: false,
  sport: "cycling",
  subSport: "road",
  isTransition: false,
  startEpochSeconds: 1_000,
  timezoneOffsetSeconds: 0,
  localDate: "1998-07-06",
  elapsedSeconds: 600,
  timerSeconds: 590,
  movingSeconds: 580,
  distanceMeters: 5_000,
  laps: [
    {
      lapSequence: 0,
      startEpochSeconds: 1_000,
      elapsedSeconds: 300,
      timerSeconds: 290,
      distanceMeters: 2_500,
    },
    {
      lapSequence: 1,
      startEpochSeconds: 1_300,
      elapsedSeconds: 300,
      timerSeconds: 290,
      distanceMeters: 2_500,
    },
  ],
};

function providerResponse(): ActivityIntervals {
  return {
    id: "private-provider-id",
    icuIntervals: [
      {
        type: "WORK",
        groupId: "group-1",
        label: "Threshold",
        startIndex: 10,
        endIndex: 310,
        startTime: 10,
        endTime: 310,
        movingTime: 300,
        elapsedTime: 300,
        distance: 2_500,
        averageWatts: 250,
        maxWatts: 310,
        averageHeartrate: 155,
        maxHeartrate: 170,
        averageCadence: 91,
        maxCadence: 104,
        zone: 4,
        intensity: 96,
        trainingLoad: 12,
        privateField: "must-not-render",
      },
      {
        type: "RECOVERY",
        groupId: "group-1",
        label: null,
        startIndex: 311,
        endIndex: 430,
        startTime: 311,
        endTime: 430,
        movingTime: 119,
        elapsedTime: 120,
        averageWatts: 110,
      },
    ],
    icuGroups: [
      {
        id: "group-1",
        movingTime: 419,
        elapsedTime: 420,
        averageWatts: 210,
        averageHeartrate: 148,
      },
    ],
  } as unknown as ActivityIntervals;
}

describe("provider interval projection", () => {
  it("preserves provider order, semantic kinds, groups, and allowlisted metrics", () => {
    const projected = projectProviderActivityIntervals(providerResponse());

    expect(projected).toMatchObject({
      source: "provider",
      intervals: [
        {
          ordinal: 1,
          groupOrdinal: 1,
          kind: "work",
          label: "Threshold",
          averagePowerWatts: 250,
          averageHeartRateBpm: 155,
        },
        {
          ordinal: 2,
          groupOrdinal: 1,
          kind: "recovery",
          label: null,
          averagePowerWatts: 110,
        },
      ],
      groups: [{ ordinal: 1, intervalOrdinals: [1, 2], kind: "unknown" }],
    });
    expect(JSON.stringify(projected)).not.toContain("private-provider-id");
    expect(JSON.stringify(projected)).not.toContain("must-not-render");
    expect(JSON.stringify(projected)).not.toContain("group-1");
  });

  it("fails closed for oversized, inconsistent, reversed, and unsafe provider data", () => {
    expect(() =>
      projectProviderActivityIntervals({
        icuIntervals: Array.from({ length: 201 }, () => ({})),
      } as ActivityIntervals),
    ).toThrow(expect.objectContaining({ code: "response-too-large" }));

    const missingGroup = providerResponse();
    missingGroup.icuGroups = [];
    expect(() => projectProviderActivityIntervals(missingGroup)).toThrow(
      expect.objectContaining({ code: "malformed-response" }),
    );

    const reversed = providerResponse();
    reversed.icuIntervals![0]!.endTime = 1;
    expect(() => projectProviderActivityIntervals(reversed)).toThrow(
      expect.objectContaining({ code: "malformed-response" }),
    );

    const unsafe = providerResponse();
    unsafe.icuIntervals![0]!.label = "unsafe\u0000label";
    expect(() => projectProviderActivityIntervals(unsafe)).toThrow(
      expect.objectContaining({ code: "malformed-response" }),
    );
  });
});

describe("interval review acquisition", () => {
  it("uses canonical laps for file-only activities and labels them as laps", async () => {
    const read = vi.fn();
    const analyzer = createIntervalReviewAnalyzer({ provider: { read } });

    await expect(
      analyzer.analyze({
        activity,
        sourceRevision: ACTIVITY_ID,
        source: { kind: "unavailable", reason: "source-not-found" },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      kind: "computed",
      source: "local-canonical",
      data: {
        source: "local-canonical",
        intervals: [
          { ordinal: 1, kind: "lap", startSeconds: 0, endSeconds: 300 },
          { ordinal: 2, kind: "lap", startSeconds: 300, endSeconds: 600 },
        ],
      },
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("archives a provider response before returning it to the analyzer", async () => {
    const events: string[] = [];
    const response = providerResponse();
    const reader = createProviderActivityIntervalReader({
      access: {
        open: async () => ({
          client: {
            activities: {
              getIntervals: async () => {
                events.push("fetch");
                return { ok: true as const, value: response };
              },
            } as never,
          },
          responseLimitExceeded: () => false,
        }),
      },
      archive: {
        write: async () => {
          events.push("archive");
        },
      },
    });
    const analyzer = createIntervalReviewAnalyzer({ provider: reader });

    await expect(
      analyzer.analyze({
        activity,
        sourceRevision: REVISION,
        source: { kind: "resolved", providerActivityId: "provider-1" as never },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ kind: "computed", source: "provider" });
    expect(events).toEqual(["fetch", "archive"]);
  });
});
