import { describe, expect, it, vi } from "vitest";
import type { CanonicalActivityDetail } from "@enduragent/kernel/store";
import { normalizeActivityStreams, type ActivityStream } from "intervals-icu-api";
import { createAerobicDriftAnalyzer, evaluateAerobicDrift } from "../src/aerobic-drift.js";

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
  startEpochSeconds: 899_985_600,
  timezoneOffsetSeconds: 0,
  localDate: "1998-07-06",
  elapsedSeconds: 3_600,
  timerSeconds: 3_600,
  movingSeconds: 3_600,
  distanceMeters: 36_000,
  laps: [],
};

function fixture(
  input: {
    readonly count?: number;
    readonly times?: number[];
    readonly power?: (index: number) => number | null;
    readonly heartRate?: (index: number) => number | null;
    readonly moving?: (index: number) => boolean;
    readonly includeMoving?: boolean;
  } = {},
): ActivityStream[] {
  const count = input.times?.length ?? input.count ?? 3_600;
  const streams: ActivityStream[] = [
    { type: "time", data: input.times ?? Array.from({ length: count }, (_, index) => index) },
    {
      type: "watts",
      data: Array.from({ length: count }, (_, index) =>
        input.power === undefined ? 200 : input.power(index),
      ),
    },
    {
      type: "heartrate",
      data: Array.from({ length: count }, (_, index) =>
        input.heartRate === undefined ? 140 : input.heartRate(index),
      ),
    },
  ];
  if (input.includeMoving !== false) {
    streams.push({
      type: "moving",
      data: Array.from({ length: count }, (_, index) => input.moving?.(index) ?? true),
    });
  }
  return streams;
}

describe("aerobic drift suitability", () => {
  it("time-weights irregular constant streams to approximately zero drift", () => {
    const result = evaluateAerobicDrift(
      fixture({
        times: [0, 300, 900, 1_500, 2_400, 3_300],
      }),
    );

    expect(result.kind).toBe("computed");
    if (result.kind !== "computed") return;
    expect(result.data.decouplingPercent).toBeCloseTo(0, 10);
    expect(result.data.coverage.fraction).toBe(1);
    expect(result.data.evidence).toBe("standard");
  });

  it("reports a positive whole-ride estimate when heart rate rises at constant power", () => {
    const result = evaluateAerobicDrift(
      fixture({
        heartRate: (index) => (index < 1_800 ? 140 : 150),
      }),
    );

    expect(result.kind).toBe("computed");
    if (result.kind !== "computed") return;
    expect(result.data.decouplingPercent).toBeCloseTo(6.67, 1);
    expect(result.data.firstHalf.averagePowerWatts).toBe(200);
    expect(result.data.secondHalf.averageHeartRateBpm).toBe(150);
  });

  it("splits a sample that crosses the time midpoint without discarding time", () => {
    const result = evaluateAerobicDrift(
      fixture({
        times: [0, 1_000, 1_700, 2_300, 3_000],
      }),
    );

    expect(result.kind).toBe("computed");
    if (result.kind !== "computed") return;
    expect(result.data.firstHalf.durationSeconds).toBeCloseTo(1_850);
    expect(result.data.secondHalf.durationSeconds).toBeCloseTo(1_850);
    expect(result.data.coverage.includedDurationSeconds).toBeCloseTo(3_700);
  });

  it("uses the whole ride, including warm-up and cool-down", () => {
    const result = evaluateAerobicDrift(
      fixture({
        power: (index) => (index < 600 ? 120 + index / 10 : index >= 3_000 ? 120 : 200),
      }),
    );

    expect(result.kind).toBe("computed");
    if (result.kind !== "computed") return;
    expect(result.data.firstHalf.averagePowerWatts).not.toBe(200);
    expect(result.data.secondHalf.averagePowerWatts).not.toBe(200);
    expect(result.data.coverage.windowDurationSeconds).toBe(3_600);
  });

  it("excludes stopped time only when a valid moving stream is present", () => {
    const result = evaluateAerobicDrift(fixture({ moving: (index) => index % 10 !== 0 }));

    expect(result.kind).toBe("computed");
    if (result.kind !== "computed") return;
    expect(result.data.coverage.fraction).toBeCloseTo(0.9);
    expect(result.data.limitations).toEqual(["duration-under-60-minutes"]);
  });

  it("fails closed for invalid moving samples", () => {
    const streams = fixture();
    streams.at(-1)!.data[3] = 1;
    expect(evaluateAerobicDrift(streams)).toEqual({
      kind: "unavailable",
      reason: "moving-status-unavailable",
    });
  });

  it("rejects long gaps, short rides, sparse coverage, and duplicate sensors", () => {
    const gapTimes = Array.from({ length: 3_600 }, (_, index) =>
      index < 1_800 ? index : index + 60,
    );
    expect(evaluateAerobicDrift(fixture({ times: gapTimes }))).toEqual({
      kind: "unavailable",
      reason: "invalid-timestamps",
    });
    expect(evaluateAerobicDrift(fixture({ count: 1_799 }))).toEqual({
      kind: "unavailable",
      reason: "activity-too-short",
    });
    expect(
      evaluateAerobicDrift(
        fixture({
          heartRate: (index) => (index % 10 < 7 ? 140 : null),
        }),
      ),
    ).toEqual({ kind: "unavailable", reason: "insufficient-coverage" });
    expect(
      evaluateAerobicDrift([
        ...fixture(),
        { type: "heartrate", data: Array.from({ length: 3_600 }, () => 140) },
      ]),
    ).toEqual({ kind: "unavailable", reason: "duplicate-stream" });
  });

  it("keeps usable but limited estimates visible with explicit limitations", () => {
    const short = evaluateAerobicDrift(fixture({ count: 2_700, includeMoving: false }));
    expect(short.kind).toBe("computed");
    if (short.kind !== "computed") return;
    expect(short.data.evidence).toBe("limited");
    expect(short.data.limitations).toEqual([
      "duration-under-60-minutes",
      "moving-status-unavailable",
    ]);

    const variable = evaluateAerobicDrift(
      fixture({
        power: (index) => (index % 2 === 0 ? 100 : 300),
      }),
    );
    expect(variable.kind).toBe("computed");
    if (variable.kind !== "computed") return;
    expect(variable.data.limitations).toEqual(["variable-output"]);
  });
});

describe("aerobic drift analyzer acquisition", () => {
  it("uses canonical streams without contacting the provider", async () => {
    const providerRead = vi.fn();
    const analyzer = createAerobicDriftAnalyzer({
      activities: {
        getStreams: async () => ({
          activityId: ACTIVITY_ID,
          channels: {
            time: fixture()[0]!.data as number[],
            power: fixture()[1]!.data as number[],
            heart_rate: fixture()[2]!.data as number[],
          },
        }),
      },
      provider: { read: providerRead },
    });

    await expect(
      analyzer.analyze({
        activity,
        sourceRevision: REVISION,
        source: { kind: "resolved", providerActivityId: "provider-1" as never },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      kind: "computed",
      source: "local-canonical",
      data: { limitations: ["moving-status-unavailable"] },
    });
    expect(providerRead).not.toHaveBeenCalled();
  });

  it("falls back to duplicate-safe provider streams when canonical sensors are absent", async () => {
    const providerRead = vi.fn(async () => ({
      kind: "available" as const,
      streams: normalizeActivityStreams(fixture()),
    }));
    const analyzer = createAerobicDriftAnalyzer({
      activities: {
        getStreams: async () => ({
          activityId: ACTIVITY_ID,
          channels: { time: Array.from({ length: 3_600 }, (_, index) => index) },
        }),
      },
      provider: { read: providerRead },
    });

    await expect(
      analyzer.analyze({
        activity,
        sourceRevision: REVISION,
        source: { kind: "resolved", providerActivityId: "provider-1" as never },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ kind: "computed", source: "provider" });
    expect(providerRead).toHaveBeenCalledWith(
      expect.objectContaining({
        providerActivityId: "provider-1",
        sourceRevision: REVISION,
      }),
    );
  });

  it("does not send file-only activity identity to a provider", async () => {
    const providerRead = vi.fn();
    const analyzer = createAerobicDriftAnalyzer({
      activities: {
        getStreams: async () => ({ activityId: ACTIVITY_ID, channels: {} }),
      },
      provider: { read: providerRead },
    });

    await expect(
      analyzer.analyze({
        activity,
        sourceRevision: REVISION,
        source: { kind: "unavailable", reason: "source-not-found" },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: "unavailable", reason: "missing-sensor-data" });
    expect(providerRead).not.toHaveBeenCalled();
  });
});
