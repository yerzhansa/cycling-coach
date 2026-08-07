import type { CanonicalActivityDetail } from "@enduragent/kernel/store";
import type { BestEfforts } from "intervals-icu-api";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BEST_EFFORT_DURATION_SECONDS,
  createBestEffortAnalyzer,
  createProviderActivityBestEffortReader,
  projectProviderBestEfforts,
} from "../src/activity-best-efforts.js";

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
  elapsedSeconds: 3_600,
  timerSeconds: 3_500,
  movingSeconds: 3_400,
  distanceMeters: 36_000,
  laps: [],
};

function response(): BestEfforts {
  return {
    efforts: [
      { average: 300, distance: 2_500, duration: 300, startIndex: 800, endIndex: 1_099 },
      { average: 310, distance: 2_600, duration: 300, startIndex: 1_200, endIndex: 1_499 },
      { average: 300, distance: null, duration: 300, startIndex: 200, endIndex: 499 },
    ],
    privateField: "must-not-render",
  } as BestEfforts;
}

describe("best-effort projection", () => {
  it("ranks by average power and resolves ties by earliest start", () => {
    const projected = projectProviderBestEfforts(response(), DEFAULT_BEST_EFFORT_DURATION_SECONDS);

    expect(projected).toEqual({
      scope: {
        kind: "selected-activity",
        stream: "power",
        durationSeconds: 300,
        tieRule: "earliest-start",
      },
      efforts: [
        {
          rank: 1,
          startIndex: 1_200,
          endIndex: 1_499,
          durationSeconds: 300,
          distanceMeters: 2_600,
          averageWatts: 310,
        },
        {
          rank: 2,
          startIndex: 200,
          endIndex: 499,
          durationSeconds: 300,
          distanceMeters: null,
          averageWatts: 300,
        },
        {
          rank: 3,
          startIndex: 800,
          endIndex: 1_099,
          durationSeconds: 300,
          distanceMeters: 2_500,
          averageWatts: 300,
        },
      ],
    });
    expect(JSON.stringify(projected)).not.toContain("must-not-render");
  });

  it("fails closed for excess, mismatched, duplicate, and non-finite efforts", () => {
    expect(() =>
      projectProviderBestEfforts(
        {
          efforts: Array.from({ length: 11 }, (_, index) => ({
            average: 200,
            duration: 300,
            startIndex: index * 300,
            endIndex: index * 300 + 299,
          })),
        } as BestEfforts,
        300,
      ),
    ).toThrow(expect.objectContaining({ code: "response-too-large" }));

    const mismatched = response();
    mismatched.efforts[0]!.duration = 60;
    expect(() => projectProviderBestEfforts(mismatched, 300)).toThrow(
      expect.objectContaining({ code: "malformed-response" }),
    );

    const duplicate = response();
    duplicate.efforts[1]!.startIndex = duplicate.efforts[0]!.startIndex;
    duplicate.efforts[1]!.endIndex = duplicate.efforts[0]!.endIndex;
    expect(() => projectProviderBestEfforts(duplicate, 300)).toThrow(
      expect.objectContaining({ code: "malformed-response" }),
    );

    const nonfinite = response();
    nonfinite.efforts[0]!.average = Number.NaN;
    expect(() => projectProviderBestEfforts(nonfinite, 300)).toThrow(
      expect.objectContaining({ code: "malformed-response" }),
    );
  });
});

describe("best-effort acquisition", () => {
  it("does not send unresolved canonical identity to the provider", async () => {
    const read = vi.fn();
    const analyzer = createBestEffortAnalyzer({ provider: { read } });

    await expect(
      analyzer.analyze({
        activity,
        sourceRevision: ACTIVITY_ID,
        source: { kind: "unavailable", reason: "source-not-found" },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: "unavailable", reason: "source-not-found" });
    expect(read).not.toHaveBeenCalled();
  });

  it("requests one fixed five-minute power search and archives before returning", async () => {
    const events: string[] = [];
    const findBestEfforts = vi.fn(async () => {
      events.push("fetch");
      return { ok: true as const, value: response() };
    });
    const reader = createProviderActivityBestEffortReader({
      access: {
        open: async () => ({
          client: { activities: { findBestEfforts } as never },
          responseLimitExceeded: () => false,
        }),
      },
      archive: {
        write: async () => {
          events.push("archive");
        },
      },
    });
    const analyzer = createBestEffortAnalyzer({ provider: reader });

    const analyzed = await analyzer.analyze({
      activity,
      sourceRevision: REVISION,
      source: { kind: "resolved", providerActivityId: "provider-1" as never },
      signal: new AbortController().signal,
    });
    expect(analyzed).toMatchObject({
      kind: "computed",
      source: "provider",
      data: { scope: { durationSeconds: 300 } },
    });
    expect(analyzed.kind === "computed" ? analyzed.data.efforts[0] : undefined).toMatchObject({
      rank: 1,
      averageWatts: 310,
    });
    expect(findBestEfforts).toHaveBeenCalledWith("provider-1", {
      stream: "watts",
      duration: 300,
      count: 10,
    });
    expect(events).toEqual(["fetch", "archive"]);
  });
});
