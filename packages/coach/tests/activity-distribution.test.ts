import type { CanonicalActivityDetail } from "@enduragent/kernel/store";
import type { HistogramBucket } from "intervals-icu-api";
import { describe, expect, it, vi } from "vitest";
import {
  createHeartRateDistributionAnalyzer,
  createPowerDistributionAnalyzer,
  createProviderActivityHistogramReader,
  projectProviderActivityHistogram,
} from "../src/activity-distribution.js";

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

const powerBuckets: HistogramBucket[] = [
  { min: 0, max: 100, secs: 300, privateField: "must-not-render" },
  { min: 100, max: 200, secs: 600 },
  { min: 225, max: 300, secs: 120 },
];

describe("activity histogram projection", () => {
  it("preserves ordered provider buckets, accumulated seconds, gaps, and endpoint units", () => {
    expect(projectProviderActivityHistogram(powerBuckets, "power")).toEqual({
      unit: "watts",
      buckets: [
        { lower: 0, upper: 100, seconds: 300 },
        { lower: 100, upper: 200, seconds: 600 },
        { lower: 225, upper: 300, seconds: 120 },
      ],
      totalSeconds: 1_020,
    });
    expect(
      projectProviderActivityHistogram(
        [
          { min: 100, max: 120, secs: 60 },
          { min: 120, max: 140, secs: 90 },
        ],
        "heart-rate",
      ),
    ).toMatchObject({ unit: "bpm", totalSeconds: 150 });
    expect(JSON.stringify(projectProviderActivityHistogram(powerBuckets, "power"))).not.toContain(
      "must-not-render",
    );
  });

  it("fails closed for oversized, overlapping, endpoint-invalid, and malformed buckets", () => {
    expect(() =>
      projectProviderActivityHistogram(
        Array.from({ length: 257 }, (_, index) => ({
          min: index,
          max: index + 1,
          secs: 1,
        })),
        "power",
      ),
    ).toThrow(expect.objectContaining({ code: "response-too-large" }));
    expect(() =>
      projectProviderActivityHistogram(
        [
          { min: 100, max: 200, secs: 60 },
          { min: 150, max: 250, secs: 60 },
        ],
        "power",
      ),
    ).toThrow(expect.objectContaining({ code: "malformed-response" }));
    expect(() =>
      projectProviderActivityHistogram([{ min: 390, max: 410, secs: 60 }], "heart-rate"),
    ).toThrow(expect.objectContaining({ code: "malformed-response" }));
    expect(() => projectProviderActivityHistogram([{ min: 100, secs: 60 }], "power")).toThrow(
      expect.objectContaining({ code: "malformed-response" }),
    );
  });
});

describe("activity histogram acquisition", () => {
  it("keeps power and heart-rate requests independent and archives before projection", async () => {
    const events: string[] = [];
    const getPowerHistogram = vi.fn(async () => {
      events.push("power:fetch");
      return { ok: true as const, value: powerBuckets };
    });
    const getHeartRateHistogram = vi.fn(async () => {
      events.push("heart-rate:fetch");
      return { ok: true as const, value: [{ min: 120, max: 140, secs: 600 }] };
    });
    const reader = createProviderActivityHistogramReader({
      access: {
        open: async () => ({
          client: { activities: { getPowerHistogram, getHeartRateHistogram } as never },
          responseLimitExceeded: () => false,
        }),
      },
      archive: {
        write: async ({ metric }) => {
          events.push(`${metric}:archive`);
        },
      },
    });
    const power = createPowerDistributionAnalyzer({ provider: reader });
    const heartRate = createHeartRateDistributionAnalyzer({ provider: reader });
    const request = {
      activity,
      sourceRevision: REVISION,
      source: { kind: "resolved" as const, providerActivityId: "provider-1" as never },
      signal: new AbortController().signal,
    };

    await expect(power.analyze(request)).resolves.toMatchObject({
      kind: "computed",
      source: "provider",
      data: { unit: "watts" },
    });
    await expect(heartRate.analyze(request)).resolves.toMatchObject({
      kind: "computed",
      source: "provider",
      data: { unit: "bpm" },
    });
    expect(events).toEqual([
      "power:fetch",
      "power:archive",
      "heart-rate:fetch",
      "heart-rate:archive",
    ]);
  });

  it("does not call the provider for unresolved rides and treats a valid empty histogram as missing sensor data", async () => {
    const read = vi.fn();
    const analyzer = createPowerDistributionAnalyzer({ provider: { read } });
    await expect(
      analyzer.analyze({
        activity,
        sourceRevision: REVISION,
        source: { kind: "unavailable", reason: "source-not-found" },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: "unavailable", reason: "source-not-found" });
    expect(read).not.toHaveBeenCalled();

    const empty = createPowerDistributionAnalyzer({
      provider: { read: async () => [] },
    });
    await expect(
      empty.analyze({
        activity,
        sourceRevision: REVISION,
        source: { kind: "resolved", providerActivityId: "provider-1" as never },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: "unavailable", reason: "missing-sensor-data" });
  });
});
