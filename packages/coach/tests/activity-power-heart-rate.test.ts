import type { CanonicalActivityDetail } from "@enduragent/kernel/store";
import type { PowerVsHeartRatePlot } from "intervals-icu-api";
import { describe, expect, it, vi } from "vitest";
import {
  createPowerHeartRateAnalyzer,
  createProviderActivityPowerHeartRateReader,
  projectProviderPowerHeartRate,
} from "../src/activity-power-heart-rate.js";

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
  laps: [],
};

function response(): PowerVsHeartRatePlot {
  return {
    elapsedTime: 600,
    hrLag: 15,
    warmup: 60,
    cooldown: 30,
    decoupling: 4.2,
    series: Array.from({ length: 6 }, (_, index) => ({
      start: index * 60,
      secs: 60,
      movingSecs: 60,
      watts: 150 + index * 10,
      hr: 120 + index * 2,
      cadence: index === 0 ? null : 85 + index,
      privateField: "must-not-render",
    })),
    curves: [
      { id: "overall", coefficients: [100, 0.1], r2: 0.9 },
      { id: "z2", coefficients: [105, 0.08], r2: 0.8 },
      { id: "private-provider-fit", coefficients: null, r2: null },
    ],
  } as PowerVsHeartRatePlot;
}

describe("provider power/heart-rate projection", () => {
  it("projects only aligned segment evidence, bounded fits, and coverage summaries", () => {
    const projected = projectProviderPowerHeartRate(response(), activity.elapsedSeconds);
    expect(projected).toMatchObject({
      source: "provider",
      coverageFraction: 0.6,
      heartRateLagSeconds: 15,
      warmupSeconds: 60,
      cooldownSeconds: 30,
      curves: [
        { kind: "all", coefficients: [100, 0.1], rSquared: 0.9 },
        { kind: "zone-2", coefficients: [105, 0.08], rSquared: 0.8 },
      ],
    });
    expect(projected.rows[0]).toEqual({
      startSeconds: 0,
      seconds: 60,
      movingSeconds: 60,
      watts: 150,
      heartRateBpm: 120,
      cadenceRpm: null,
    });
    expect(JSON.stringify(projected)).not.toContain("decoupling");
    expect(JSON.stringify(projected)).not.toContain("must-not-render");
    expect(JSON.stringify(projected)).not.toContain("private-provider-fit");
  });

  it("fails closed for oversized, overlapping, impossible-motion, and malformed curve data", () => {
    const oversized = response();
    oversized.series = Array.from({ length: 257 }, (_, index) => ({
      start: index,
      secs: 1,
      watts: 150,
      hr: 120,
    }));
    expect(() => projectProviderPowerHeartRate(oversized, 600)).toThrow(
      expect.objectContaining({ code: "response-too-large" }),
    );

    const overlapping = response();
    overlapping.series[1]!.start = 30;
    expect(() => projectProviderPowerHeartRate(overlapping, 600)).toThrow(
      expect.objectContaining({ code: "malformed-response" }),
    );

    const impossibleMotion = response();
    impossibleMotion.series[0]!.movingSecs = 61;
    expect(() => projectProviderPowerHeartRate(impossibleMotion, 600)).toThrow(
      expect.objectContaining({ code: "malformed-response" }),
    );

    const nullCoefficient = response();
    nullCoefficient.curves![0]!.coefficients = [100, null];
    expect(() => projectProviderPowerHeartRate(nullCoefficient, 600)).toThrow(
      expect.objectContaining({ code: "malformed-response" }),
    );
  });
});

describe("provider power/heart-rate acquisition", () => {
  it("archives the server response before projection and returns adequate evidence", async () => {
    const events: string[] = [];
    const getPowerVsHeartRate = vi.fn(async () => {
      events.push("fetch");
      return { ok: true as const, value: response() };
    });
    const reader = createProviderActivityPowerHeartRateReader({
      access: {
        open: async () => ({
          client: { activities: { getPowerVsHeartRate } as never },
          responseLimitExceeded: () => false,
        }),
      },
      archive: {
        write: async () => {
          events.push("archive");
        },
      },
    });
    const analyzer = createPowerHeartRateAnalyzer({ provider: reader });

    await expect(
      analyzer.analyze({
        activity,
        sourceRevision: REVISION,
        source: { kind: "resolved", providerActivityId: "provider-1" as never },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      kind: "computed",
      source: "provider",
      data: { coverageFraction: 0.6 },
    });
    expect(getPowerVsHeartRate).toHaveBeenCalledWith("provider-1");
    expect(events).toEqual(["fetch", "archive"]);
  });

  it("fails closed for unresolved, empty, short, low-coverage, and no-spread evidence", async () => {
    const read = vi.fn(async () => response());
    const analyzer = createPowerHeartRateAnalyzer({ provider: { read } });
    await expect(
      analyzer.analyze({
        activity,
        sourceRevision: REVISION,
        source: { kind: "unavailable", reason: "source-not-found" },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: "unavailable", reason: "source-not-found" });
    expect(read).not.toHaveBeenCalled();

    const empty = response();
    empty.series = [];
    await expect(
      createPowerHeartRateAnalyzer({ provider: { read: async () => empty } }).analyze({
        activity,
        sourceRevision: REVISION,
        source: { kind: "resolved", providerActivityId: "provider-1" as never },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: "unavailable", reason: "missing-sensor-data" });

    const short = response();
    short.series = short.series.slice(0, 4);
    await expect(
      createPowerHeartRateAnalyzer({ provider: { read: async () => short } }).analyze({
        activity,
        sourceRevision: REVISION,
        source: { kind: "resolved", providerActivityId: "provider-1" as never },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: "unavailable", reason: "activity-too-short" });

    const lowCoverage = response();
    lowCoverage.elapsedTime = 3_600;
    await expect(
      createPowerHeartRateAnalyzer({ provider: { read: async () => lowCoverage } }).analyze({
        activity: { ...activity, elapsedSeconds: 3_600 },
        sourceRevision: REVISION,
        source: { kind: "resolved", providerActivityId: "provider-1" as never },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: "unavailable", reason: "insufficient-coverage" });

    const noSpread = response();
    noSpread.series = noSpread.series.map((row) => ({ ...row, watts: 180, hr: 130 }));
    await expect(
      createPowerHeartRateAnalyzer({ provider: { read: async () => noSpread } }).analyze({
        activity,
        sourceRevision: REVISION,
        source: { kind: "resolved", providerActivityId: "provider-1" as never },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: "unavailable", reason: "unsuitable-activity" });
  });
});
