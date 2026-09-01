import { TrainingHistoryProjectionSchema, type Freshness } from "@enduragent/coach-contract";
import type {
  CoverageCommitRow,
  RecordedFact,
  TrainingCoverageReader,
  TrainingHistoryFactRow,
  TrainingHistoryReader,
} from "@enduragent/kernel/store";
import { describe, expect, it, vi } from "vitest";
import { createTrainingHistorySource } from "../src/training-history.js";

const AS_OF = "1998-07-10T12:00:00.000Z";

function absent(): RecordedFact<number> {
  return { kind: "absent" };
}

function recorded(value: number): RecordedFact<number> {
  return { kind: "recorded", value };
}

function rejected(): RecordedFact<number> {
  return { kind: "rejected", reason: "invalid-value" };
}

function ride(input: {
  readonly id: string;
  readonly localDate: string;
  readonly hour?: number;
  readonly startEpochSeconds?: number;
  readonly timezoneOffsetSeconds?: number | null;
  readonly movingSeconds?: number | null;
  readonly elapsedSeconds?: number | null;
  readonly distanceMeters?: number | null;
  readonly load?: RecordedFact<number>;
}): TrainingHistoryFactRow {
  const hour = input.hour ?? 12;
  return {
    id: input.id,
    localDate: input.localDate,
    startEpochSeconds:
      input.startEpochSeconds ??
      Date.parse(`${input.localDate}T${String(hour).padStart(2, "0")}:00:00.000Z`) / 1_000,
    timezoneOffsetSeconds:
      "timezoneOffsetSeconds" in input ? (input.timezoneOffsetSeconds ?? null) : 0,
    subSport: "road",
    movingSeconds: "movingSeconds" in input ? (input.movingSeconds ?? null) : 3_600,
    elapsedSeconds: "elapsedSeconds" in input ? (input.elapsedSeconds ?? null) : 3_900,
    distanceMeters: "distanceMeters" in input ? (input.distanceMeters ?? null) : 25_000,
    title: "Sentinel ride",
    load: input.load ?? recorded(50),
    averagePowerWatts: recorded(210),
    averageHeartRateBpm: recorded(145),
    perceivedExertion: recorded(6),
    energyKilojoules: recorded(720),
  };
}

function commit(input: {
  readonly id: number;
  readonly oldest?: string;
  readonly newest?: string;
  readonly committedAt?: string;
  readonly zone?: string;
  readonly gapState?: "none" | "undated-dropped-rows";
}): CoverageCommitRow {
  const committedAt = input.committedAt ?? AS_OF;
  return {
    coverageCommitId: input.id,
    source: "intervals-icu",
    lane: "activities",
    authorityKind: "reference-capture",
    authorityId: `sentinel-capture-${input.id}`,
    calendarTimeZone: input.zone ?? "UTC",
    coveredOldest: input.oldest ?? "1998-05-01",
    coveredNewest: input.newest ?? "1998-07-10",
    committedEpochSeconds: Date.parse(committedAt) / 1_000,
    gapState: input.gapState ?? "none",
  };
}

function source(input: {
  readonly rows?: readonly TrainingHistoryFactRow[];
  readonly commits?: readonly CoverageCommitRow[];
  readonly scanTruncated?: boolean;
  readonly readFailure?: Error;
}) {
  const readWindow = vi.fn<TrainingHistoryReader["readWindow"]>(async () => {
    if (input.readFailure !== undefined) throw input.readFailure;
    return {
      rows: input.rows ?? [],
      scanTruncated: input.scanTruncated ?? false,
    };
  });
  const listCommits = vi.fn<TrainingCoverageReader["listCommits"]>(async () => input.commits ?? []);
  return {
    readWindow,
    listCommits,
    trainingHistory: createTrainingHistorySource({
      facts: { readWindow },
      coverage: { listCommits },
    }),
  };
}

async function read(input: {
  readonly rows?: readonly TrainingHistoryFactRow[];
  readonly commits?: readonly CoverageCommitRow[];
  readonly scanTruncated?: boolean;
  readonly readFailure?: Error;
  readonly asOf?: string;
  readonly calendarTimeZone?: string;
  readonly freshness?: Freshness;
  readonly sourceRestricted?: boolean;
}) {
  const fixture = source(input);
  const asOf = input.asOf ?? AS_OF;
  const projection = await fixture.trainingHistory.readTrainingHistory({
    asOf,
    asOfEpochSeconds: Date.parse(asOf) / 1_000,
    calendarTimeZone: input.calendarTimeZone ?? "UTC",
    freshness: input.freshness ?? "fresh",
    sourceRestricted: input.sourceRestricted ?? false,
  });
  return { ...fixture, projection };
}

describe("training history projection", () => {
  it("projects anchor and previous rides through the contract in one bounded read", async () => {
    const anchorRide = ride({ id: "a".repeat(64), localDate: "1998-07-08", hour: 14 });
    const previousRide = ride({ id: "b".repeat(64), localDate: "1998-07-03", hour: 9 });
    const result = await read({
      rows: [anchorRide, previousRide],
      commits: [commit({ id: 1 })],
    });

    expect(result.projection.kind).toBe("computed");
    expect(TrainingHistoryProjectionSchema.parse(result.projection)).toEqual(result.projection);
    expect(result.readWindow).toHaveBeenCalledOnce();
    expect(result.readWindow).toHaveBeenCalledWith({ start: "1998-05-25", end: "1998-07-12" });
    expect(result.listCommits).toHaveBeenCalledWith({
      source: "intervals-icu",
      lane: "activities",
    });
    if (result.projection.kind !== "computed") return;
    expect(result.projection.anchorWeek.rides.items.map((item) => item.id)).toEqual([
      anchorRide.id,
    ]);
    expect(result.projection.previousWeek?.rides.items.map((item) => item.id)).toEqual([
      previousRide.id,
    ]);
    expect(result.projection.anchorWeek.callout).toBeNull();
    expect(result.projection.previousWeek?.callout).toBeNull();
  });

  it("keeps proven zero-ride weeks as empty computed windows", async () => {
    const result = await read({ commits: [commit({ id: 1 })] });

    expect(result.projection.kind).toBe("computed");
    if (result.projection.kind !== "computed") return;
    expect(result.projection.anchorWeek).toMatchObject({
      window: { start: "1998-07-06", end: "1998-07-12" },
      coverage: { kind: "complete" },
      totals: {
        rideCount: { kind: "computed", value: 0 },
        ridingSeconds: { kind: "computed", value: 0 },
        distanceMeters: { kind: "computed", value: 0 },
        load: { kind: "computed", value: 0 },
      },
      rides: { count: { kind: "exact", value: 0 }, items: [], truncated: false },
      trend: { kind: "computed" },
      callout: null,
    });
    expect(result.projection.previousWeek).toMatchObject({
      window: { start: "1998-06-29", end: "1998-07-05" },
      coverage: { kind: "complete" },
      rides: { items: [] },
      callout: null,
    });
  });

  it("falls back from absent moving time to elapsed time and records the basis", async () => {
    const result = await read({
      rows: [
        ride({
          id: "c".repeat(64),
          localDate: "1998-07-08",
          movingSeconds: null,
          elapsedSeconds: 4_200,
        }),
      ],
      commits: [commit({ id: 1 })],
    });

    expect(result.projection.kind).toBe("computed");
    if (result.projection.kind !== "computed") return;
    expect(result.projection.anchorWeek.rides.items[0]).toMatchObject({
      ridingSeconds: 4_200,
      ridingTimeBasis: "elapsed",
      elapsedSeconds: 4_200,
    });
  });

  it("distinguishes rejected and absent Load while counting known missing values", async () => {
    const result = await read({
      rows: [
        ride({
          id: "d".repeat(64),
          localDate: "1998-07-09",
          movingSeconds: null,
          elapsedSeconds: null,
          distanceMeters: null,
          load: rejected(),
        }),
        ride({ id: "e".repeat(64), localDate: "1998-07-08", hour: 10 }),
        ride({ id: "f".repeat(64), localDate: "1998-07-02", load: absent() }),
      ],
      commits: [commit({ id: 1 })],
    });

    expect(result.projection.kind).toBe("computed");
    if (result.projection.kind !== "computed" || result.projection.previousWeek === null) return;
    expect(result.projection.anchorWeek.totals).toMatchObject({
      ridingSeconds: {
        kind: "partial",
        value: 3_600,
        reason: "missing-recorded-value",
        knownRideMissingValueCount: 1,
      },
      distanceMeters: {
        kind: "partial",
        value: 25_000,
        reason: "missing-recorded-value",
        knownRideMissingValueCount: 1,
      },
      load: {
        kind: "partial",
        value: 50,
        reason: "missing-recorded-value",
        knownRideMissingValueCount: 1,
      },
    });
    expect(result.projection.previousWeek.totals.load).toEqual({
      kind: "unavailable",
      reason: "no-recorded-value",
    });
    expect(result.projection.anchorWeek.rides.items[0]?.load).toBeNull();

    const invalidOnly = await read({
      rows: [ride({ id: "1".repeat(64), localDate: "1998-07-08", load: rejected() })],
      commits: [commit({ id: 2 })],
    });
    expect(invalidOnly.projection.kind).toBe("computed");
    if (invalidOnly.projection.kind !== "computed") return;
    expect(invalidOnly.projection.anchorWeek.totals.load).toEqual({
      kind: "unavailable",
      reason: "invalid-recorded-value",
    });
  });

  it("folds superseding commits into contiguous, incomplete, and sparse coverage", async () => {
    const supersededGap = commit({
      id: 1,
      gapState: "undated-dropped-rows",
      committedAt: "1998-07-09T12:00:00.000Z",
    });
    const clean = commit({ id: 2 });
    const contiguous = await read({ commits: [supersededGap, clean] });
    expect(contiguous.projection).toMatchObject({
      kind: "computed",
      coverage: {
        kind: "contiguous",
        start: "1998-05-01",
        through: "1998-07-10",
        committedAt: AS_OF,
      },
    });

    const incomplete = await read({
      commits: [
        clean,
        commit({
          id: 3,
          gapState: "undated-dropped-rows",
          committedAt: "1998-07-10T13:00:00.000Z",
        }),
      ],
    });
    expect(incomplete.projection).toMatchObject({
      kind: "computed",
      coverage: {
        kind: "incomplete",
        provenStart: "1998-05-01",
        provenThrough: "1998-07-10",
        observedThrough: "1998-07-10",
        committedAt: "1998-07-10T13:00:00.000Z",
        reason: "undated-dropped-rows",
      },
    });

    const sparse = await read({
      rows: [ride({ id: "2".repeat(64), localDate: "1998-05-26" })],
      commits: [],
    });
    expect(sparse.projection).toMatchObject({
      kind: "computed",
      displayMode: "last-recorded",
      coverage: {
        kind: "sparse",
        latestKnownRideDate: "1998-05-26",
        latestImportAt: null,
      },
      anchorWeek: { window: { start: "1998-05-25", end: "1998-05-31" } },
    });
    expect(sparse.readWindow).toHaveBeenCalledWith({ start: "1900-01-01", end: "1998-07-12" });
  });

  it("limits scan coverage at the oldest returned week without degrading newer weeks", async () => {
    const newestEpoch = Date.parse("1998-07-08T12:00:00.000Z") / 1_000;
    const anchorRows = Array.from({ length: 999 }, (_, index) =>
      ride({
        id: (index + 1).toString(16).padStart(64, "0"),
        localDate: "1998-07-08",
        startEpochSeconds: newestEpoch - index,
      }),
    );
    const result = await read({
      rows: [...anchorRows, ride({ id: "f".repeat(64), localDate: "1998-07-03" })],
      commits: [commit({ id: 1 })],
      scanTruncated: true,
    });

    expect(result.projection.kind).toBe("computed");
    if (result.projection.kind !== "computed" || result.projection.previousWeek === null) return;
    expect(result.projection.anchorWeek.coverage).toEqual({ kind: "complete" });
    expect(result.projection.anchorWeek.rides.count).toEqual({ kind: "exact", value: 999 });
    expect(result.projection.previousWeek.coverage).toEqual({
      kind: "incomplete",
      recordedThrough: "1998-07-10",
      reason: "scan-limit",
    });
    expect(result.projection.previousWeek.rides.count).toEqual({ kind: "at-least", value: 1 });

    const crossWeekCutoff = await read({
      rows: [
        ...anchorRows,
        ride({
          id: "e".repeat(64),
          localDate: "1998-07-05",
          startEpochSeconds: Date.parse("1998-07-05T23:30:00.000Z") / 1_000,
          timezoneOffsetSeconds: -43_200,
        }),
      ],
      commits: [commit({ id: 2 })],
      scanTruncated: true,
    });
    expect(crossWeekCutoff.projection.kind).toBe("computed");
    if (crossWeekCutoff.projection.kind !== "computed") return;
    expect(crossWeekCutoff.projection.anchorWeek.coverage).toEqual({
      kind: "incomplete",
      recordedThrough: "1998-07-10",
      reason: "scan-limit",
    });
  });

  it("returns typed unavailable results and never emits stale", async () => {
    const noAnchor = await read({ commits: [] });
    expect(noAnchor.projection).toEqual({
      kind: "unavailable",
      reason: "coverage-unavailable",
    });

    const failed = await read({
      commits: [commit({ id: 1 })],
      readFailure: new Error("sentinel read failure"),
    });
    expect(failed.projection).toEqual({
      kind: "unavailable",
      reason: "temporary-failure",
    });
    expect([noAnchor.projection.kind, failed.projection.kind]).not.toContain("stale");
  });

  it("returns unavailable for stale incomplete history without a safe anchor", async () => {
    const restricted = await read({
      freshness: "stale",
      sourceRestricted: true,
      commits: [],
    });
    expect(restricted.projection).toEqual({
      kind: "unavailable",
      reason: "coverage-unavailable",
    });

    const mismatchedZone = await read({
      freshness: "critical",
      commits: [commit({ id: 1, zone: "America/New_York" })],
    });
    expect(mismatchedZone.projection).toEqual({
      kind: "unavailable",
      reason: "coverage-unavailable",
    });

    const restrictedMismatch = await read({
      freshness: "stale",
      sourceRestricted: true,
      commits: [commit({ id: 2, zone: "America/New_York" })],
    });
    expect(restrictedMismatch.projection).toEqual({
      kind: "unavailable",
      reason: "coverage-unavailable",
    });

    const latestSafeRide = await read({
      freshness: "stale",
      sourceRestricted: true,
      rows: [ride({ id: "4".repeat(64), localDate: "1998-05-26" })],
      commits: [],
    });
    expect(latestSafeRide.projection).toMatchObject({
      kind: "computed",
      displayMode: "last-recorded",
      coverage: { kind: "incomplete", reason: "source-degraded" },
      anchorWeek: { window: { start: "1998-05-25", end: "1998-05-31" } },
    });
    expect(latestSafeRide.readWindow).toHaveBeenCalledWith({
      start: "1900-01-01",
      end: "1998-07-12",
    });
  });

  it("anchors today in the requested calendar time zone", async () => {
    const asOf = "1998-07-06T00:30:00.000Z";
    const zone = "America/Los_Angeles";
    const result = await read({
      asOf,
      calendarTimeZone: zone,
      commits: [
        commit({
          id: 1,
          zone,
          newest: "1998-07-05",
          committedAt: "1998-07-06T00:00:00.000Z",
        }),
      ],
    });

    expect(result.projection.kind).toBe("computed");
    if (result.projection.kind !== "computed") return;
    expect(result.projection.anchorWeek.window).toEqual({
      start: "1998-06-29",
      end: "1998-07-05",
    });
    expect(result.projection.calendarTimeZone).toBe(zone);
  });
});
