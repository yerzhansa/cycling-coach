import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  ACTIVITY_ANALYSIS_SECTIONS,
  ActivityAnalysisResultSchema,
  ActivityAnalysisRequestSchema,
  CanonicalActivitySummarySchema,
  createActivityAnalysisResultSchema,
  type ActivityAnalysisRequest,
  type AnalysisSection,
} from "../src/index.js";

const ID = "a".repeat(64);
const WORKOUT_ID = "b".repeat(64);
const REVISION = "c".repeat(64);
const INSTANT = "1998-07-06T12:00:00.000Z";

const activity = {
  id: ID,
  workoutId: WORKOUT_ID,
  sessionSequence: 0,
  isMultisport: false,
  sport: "cycling",
  subSport: null,
  isTransition: false,
  startEpochSeconds: 899_985_600,
  timezoneOffsetSeconds: 0,
  localDate: "1998-07-06",
  elapsedSeconds: 3_600,
  timerSeconds: 3_500,
  movingSeconds: 3_400,
  distanceMeters: 40_000,
} as const;

const scalarData = z.object({ value: z.number().finite().min(-1_000).max(1_000) }).strict();
const dataSchemas = {
  aerobicDrift: scalarData,
  intervals: z.object({ count: z.number().int().nonnegative().max(200) }).strict(),
  bestEfforts: z.object({ count: z.number().int().nonnegative().max(10) }).strict(),
  powerDistribution: z.object({ buckets: z.number().int().nonnegative().max(256) }).strict(),
  heartRateDistribution: z.object({ buckets: z.number().int().nonnegative().max(256) }).strict(),
  powerHeartRate: z.object({ rows: z.number().int().nonnegative().max(256) }).strict(),
} as const;
const ResultSchema = createActivityAnalysisResultSchema(dataSchemas);

const provenance = {
  source: "local-canonical",
  delivery: "live",
  observedAt: INSTANT,
} as const;

describe("activity analysis contract", () => {
  it("accepts only a bounded unique semantic section request", () => {
    const request = {
      canonicalActivityId: ID,
      sections: [...ACTIVITY_ANALYSIS_SECTIONS],
      refresh: true,
    } as const;
    expect(ActivityAnalysisRequestSchema.parse(request)).toEqual(request);
    expectTypeOf<ActivityAnalysisRequest["sections"][number]>()
      .toEqualTypeOf<(typeof ACTIVITY_ANALYSIS_SECTIONS)[number]>();

    for (const invalid of [
      { canonicalActivityId: "provider-id", sections: ["intervals"] },
      { canonicalActivityId: ID, sections: [] },
      { canonicalActivityId: ID, sections: ["intervals", "intervals"] },
      { canonicalActivityId: ID, sections: ["raw-provider-payload"] },
      { canonicalActivityId: ID, sections: ["intervals"], providerActivityId: "i42" },
    ]) {
      expect(ActivityAnalysisRequestSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("strictly validates the renderer-safe canonical activity summary", () => {
    expect(CanonicalActivitySummarySchema.parse(activity)).toEqual(activity);
    for (const invalid of [
      { ...activity, localDate: "1998-02-30" },
      { ...activity, sport: "" },
      { ...activity, sport: `cycling${String.fromCharCode(10)}unsafe` },
      { ...activity, subSport: `virtual${String.fromCodePoint(0x202e)}unsafe` },
      { ...activity, distanceMeters: Infinity },
      { ...activity, timezoneOffsetSeconds: 100_000 },
      { ...activity, providerActivityId: "i42" },
    ]) {
      expect(CanonicalActivitySummarySchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("accepts independent computed, unavailable, and stale section states", () => {
    const computed = { kind: "computed", data: { value: 2.5 }, provenance } as const;
    const result = {
      schemaVersion: 1,
      activity,
      revision: REVISION,
      sections: {
        aerobicDrift: computed,
        intervals: { kind: "unavailable", reason: "not-provider-backed" },
        bestEfforts: {
          kind: "stale",
          lastGood: {
            kind: "computed",
            data: { count: 3 },
            provenance: { ...provenance, delivery: "persisted-cache" },
          },
          refreshFailure: { code: "timeout", failedAt: INSTANT },
        },
      },
    } as const;
    expect(ResultSchema.parse(result)).toEqual(result);
    expectTypeOf<Extract<AnalysisSection<{ value: number }>, { kind: "computed" }>["data"]>()
      .toEqualTypeOf<{ value: number }>();
  });

  it("rejects unbounded payloads, arbitrary errors, identity leaks, and empty results", () => {
    const base = {
      schemaVersion: 1,
      activity,
      revision: REVISION,
      sections: {
        aerobicDrift: { kind: "computed", data: { value: 2.5 }, provenance },
      },
    } as const;
    for (const invalid of [
      { ...base, revision: "provider-revision" },
      { ...base, providerActivityId: "i42" },
      { ...base, sections: {} },
      { ...base, sections: { rawPayload: { kind: "unavailable", reason: "unsupported" } } },
      { ...base, sections: { aerobicDrift: { ...base.sections.aerobicDrift, data: { value: 2.5, raw: {} } } } },
      { ...base, sections: { aerobicDrift: { kind: "unavailable", reason: "network", message: "/private/path" } } },
      { ...base, sections: { aerobicDrift: { kind: "unavailable", reason: "unknown-upstream-error" } } },
      { ...base, sections: { aerobicDrift: { kind: "computed", data: { value: NaN }, provenance } } },
      { ...base, sections: { aerobicDrift: { kind: "computed", data: { value: 2.5 },
        provenance: { ...provenance, providerActivityId: "i42" } } } },
      { ...base, sections: { aerobicDrift: { kind: "stale", lastGood: base.sections.aerobicDrift,
        refreshFailure: { code: "timeout", failedAt: INSTANT, message: "/private/path" } } } },
    ]) {
      expect(ResultSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("freezes concrete units and bounds for every renderer section", () => {
    const concrete = {
      schemaVersion: 1,
      activity,
      revision: REVISION,
      sections: {
        aerobicDrift: {
          kind: "computed",
          data: {
            method: "local-time-weighted-efficiency-factor",
            firstHalf: {
              durationSeconds: 1_800,
              sampleCount: 1_800,
              averagePowerWatts: 200,
              averageHeartRateBpm: 140,
              efficiencyFactor: 1.43,
            },
            secondHalf: {
              durationSeconds: 1_800,
              sampleCount: 1_800,
              averagePowerWatts: 198,
              averageHeartRateBpm: 145,
              efficiencyFactor: 1.37,
            },
            decouplingPercent: 4.2,
            coverage: {
              totalSamples: 3_600,
              validSamples: 3_600,
              includedDurationSeconds: 3_600,
              windowDurationSeconds: 3_600,
              fraction: 1,
            },
            evidence: "standard",
            limitations: [],
          },
          provenance,
        },
        powerDistribution: {
          kind: "computed",
          data: {
            unit: "watts",
            buckets: [{ lower: 100, upper: 125, seconds: 600 }],
            totalSeconds: 600,
          },
          provenance: { ...provenance, source: "provider" },
        },
        heartRateDistribution: {
          kind: "computed",
          data: {
            unit: "bpm",
            buckets: [{ lower: 130, upper: 135, seconds: 600 }],
            totalSeconds: 600,
          },
          provenance: { ...provenance, source: "provider" },
        },
      },
    } as const;
    expect(ActivityAnalysisResultSchema.parse(concrete)).toEqual(concrete);
    expect(ActivityAnalysisResultSchema.safeParse({
      ...concrete,
      sections: {
        ...concrete.sections,
        powerDistribution: {
          ...concrete.sections.powerDistribution,
          data: { ...concrete.sections.powerDistribution.data, unit: "bpm" },
        },
      },
    }).success).toBe(false);
    expect(ActivityAnalysisResultSchema.safeParse({
      ...concrete,
      sections: {
        ...concrete.sections,
        aerobicDrift: {
          ...concrete.sections.aerobicDrift,
          data: {
            ...concrete.sections.aerobicDrift.data,
            evidence: "limited",
            limitations: [],
          },
        },
      },
    }).success).toBe(false);
    expect(ActivityAnalysisResultSchema.safeParse({
      ...concrete,
      sections: {
        intervals: {
          kind: "computed",
          data: { source: "provider", intervals: [], groups: [] },
          provenance,
        },
      },
    }).success).toBe(false);
    expect(ActivityAnalysisResultSchema.safeParse({
      ...concrete,
      sections: {
        powerDistribution: {
          kind: "computed",
          data: { unit: "watts", buckets: [], totalSeconds: 0 },
          provenance: { ...provenance, source: "provider" },
        },
      },
    }).success).toBe(false);
    expect(ActivityAnalysisResultSchema.safeParse({
      ...concrete,
      sections: {
        powerHeartRate: {
          kind: "computed",
          data: {
            source: "provider",
            rows: [],
            curves: [],
            coverageFraction: 0,
            heartRateLagSeconds: null,
            warmupSeconds: null,
            cooldownSeconds: null,
          },
          provenance: { ...provenance, source: "provider" },
        },
      },
    }).success).toBe(false);
  });
});
