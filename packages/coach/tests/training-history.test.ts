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
const DEFAULT_COMMITTED_AT = "1998-07-11T12:00:00.000Z";

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
  readonly datedLocalDates?: readonly string[];
  readonly undatedCount?: number;
}): CoverageCommitRow {
  const committedAt = input.committedAt ?? DEFAULT_COMMITTED_AT;
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
    gaps: {
      datedLocalDates: input.datedLocalDates ?? [],
      undatedCount: input.undatedCount ?? 0,
    },
  };
}

function source(input: {
  readonly rows?: readonly TrainingHistoryFactRow[];
  readonly commits?: readonly CoverageCommitRow[];
  readonly scanTruncated?: boolean;
  readonly readFailure?: Error;
}) {
  const readLatestRideDate = vi.fn<TrainingHistoryReader["readLatestRideDate"]>(async (window) =>
    (input.rows ?? [])
      .filter((row) => row.localDate <= window.through)
      .reduce<string | null>(
        (latest, row) => (latest === null || row.localDate > latest ? row.localDate : latest),
        null,
      ),
  );
  const readWindow = vi.fn<TrainingHistoryReader["readWindow"]>(async () => {
    if (input.readFailure !== undefined) throw input.readFailure;
    return {
      rows: input.rows ?? [],
      scanTruncated: input.scanTruncated ?? false,
    };
  });
  const listCommits = vi.fn<TrainingCoverageReader["listCommits"]>(async () => input.commits ?? []);
  return {
    readLatestRideDate,
    readWindow,
    listCommits,
    trainingHistory: createTrainingHistorySource({
      facts: { readLatestRideDate, readWindow },
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

  it("selects the unique longest returned ride in the complete 28-day window", async () => {
    const winner = ride({
      id: "1".repeat(64),
      localDate: "1998-07-08",
      movingSeconds: 7_200,
    });
    const result = await read({
      asOf: "1998-07-12T12:00:00.000Z",
      rows: [
        winner,
        ride({ id: "2".repeat(64), localDate: "1998-07-04", movingSeconds: 6_000 }),
        ride({ id: "3".repeat(64), localDate: "1998-06-28", movingSeconds: 5_400 }),
        ride({ id: "4".repeat(64), localDate: "1998-06-20", movingSeconds: 4_800 }),
      ],
      commits: [
        commit({
          id: 1,
          newest: "1998-07-12",
          committedAt: "1998-07-13T12:00:00.000Z",
        }),
      ],
    });

    expect(result.projection.kind).toBe("computed");
    if (result.projection.kind !== "computed") return;
    expect(result.projection.anchorWeek.callout).toEqual({
      kind: "longest-ride-28d",
      rideId: winner.id,
      durationSeconds: 7_200,
      window: { start: "1998-06-15", end: "1998-07-12" },
      comparisonRideCount: 4,
    });
    expect(result.projection.previousWeek?.callout).toBeNull();
  });

  it("returns no callout when the winner is not one of the returned ride items", async () => {
    const visible = Array.from({ length: 50 }, (_, index) =>
      ride({
        id: (index + 1).toString(16).padStart(64, "0"),
        localDate: "1998-07-08",
        movingSeconds: 3_600 + index,
      }),
    );
    const result = await read({
      rows: [
        ...visible,
        ride({ id: "f".repeat(64), localDate: "1998-07-06", movingSeconds: 10_000 }),
      ],
      commits: [commit({ id: 1 })],
    });

    expect(result.projection.kind).toBe("computed");
    if (result.projection.kind !== "computed") return;
    expect(result.projection.anchorWeek.rides.items).toHaveLength(50);
    expect(result.projection.anchorWeek.rides.truncated).toBe(true);
    expect(result.projection.anchorWeek.callout).toBeNull();
  });

  it("returns no callout when the longest riding time is tied", async () => {
    const result = await read({
      rows: [
        ride({ id: "1".repeat(64), localDate: "1998-07-08", movingSeconds: 7_200 }),
        ride({ id: "2".repeat(64), localDate: "1998-07-07", movingSeconds: 7_200 }),
        ride({ id: "3".repeat(64), localDate: "1998-07-04", movingSeconds: 5_400 }),
        ride({ id: "4".repeat(64), localDate: "1998-06-20", movingSeconds: 4_800 }),
      ],
      commits: [commit({ id: 1 })],
    });

    expect(result.projection.kind).toBe("computed");
    if (result.projection.kind !== "computed") return;
    expect(result.projection.anchorWeek.callout).toBeNull();
  });

  it("returns no callout with fewer than four comparable rides", async () => {
    const result = await read({
      rows: [
        ride({ id: "1".repeat(64), localDate: "1998-07-08", movingSeconds: 7_200 }),
        ride({ id: "2".repeat(64), localDate: "1998-07-04", movingSeconds: 6_000 }),
        ride({ id: "3".repeat(64), localDate: "1998-06-20", movingSeconds: 4_800 }),
      ],
      commits: [commit({ id: 1 })],
    });

    expect(result.projection.kind).toBe("computed");
    if (result.projection.kind !== "computed") return;
    expect(result.projection.anchorWeek.callout).toBeNull();
  });

  it("returns no callout when any ride in the comparison window lacks riding time", async () => {
    const result = await read({
      rows: [
        ride({ id: "1".repeat(64), localDate: "1998-07-08", movingSeconds: 7_200 }),
        ride({ id: "2".repeat(64), localDate: "1998-07-04", movingSeconds: 6_000 }),
        ride({
          id: "3".repeat(64),
          localDate: "1998-06-28",
          movingSeconds: null,
          elapsedSeconds: null,
        }),
        ride({ id: "4".repeat(64), localDate: "1998-06-20", movingSeconds: 4_800 }),
      ],
      commits: [commit({ id: 1 })],
    });

    expect(result.projection.kind).toBe("computed");
    if (result.projection.kind !== "computed") return;
    expect(result.projection.anchorWeek.callout).toBeNull();
  });

  it("returns no callout for incomplete source coverage", async () => {
    const result = await read({
      rows: [
        ride({ id: "1".repeat(64), localDate: "1998-07-08", movingSeconds: 7_200 }),
        ride({ id: "2".repeat(64), localDate: "1998-07-04", movingSeconds: 6_000 }),
        ride({ id: "3".repeat(64), localDate: "1998-06-28", movingSeconds: 5_400 }),
        ride({ id: "4".repeat(64), localDate: "1998-06-20", movingSeconds: 4_800 }),
      ],
      commits: [commit({ id: 1 })],
      sourceRestricted: true,
    });

    expect(result.projection.kind).toBe("computed");
    if (result.projection.kind !== "computed") return;
    expect(result.projection.coverage.kind).toBe("incomplete");
    expect(result.projection.anchorWeek.callout).toBeNull();
  });

  it("returns no callout when contiguous history does not cover all 28 dates", async () => {
    const result = await read({
      rows: [
        ride({ id: "1".repeat(64), localDate: "1998-07-08", movingSeconds: 7_200 }),
        ride({ id: "2".repeat(64), localDate: "1998-07-04", movingSeconds: 6_000 }),
        ride({ id: "3".repeat(64), localDate: "1998-06-28", movingSeconds: 5_400 }),
        ride({ id: "4".repeat(64), localDate: "1998-06-20", movingSeconds: 4_800 }),
      ],
      commits: [commit({ id: 1, oldest: "1998-06-20" })],
    });

    expect(result.projection.kind).toBe("computed");
    if (result.projection.kind !== "computed") return;
    expect(result.projection.anchorWeek.callout).toBeNull();
  });

  it("returns no callout when the history read hit its scan limit", async () => {
    const result = await read({
      rows: [
        ride({ id: "1".repeat(64), localDate: "1998-07-08", movingSeconds: 7_200 }),
        ride({ id: "2".repeat(64), localDate: "1998-07-04", movingSeconds: 6_000 }),
        ride({ id: "3".repeat(64), localDate: "1998-06-28", movingSeconds: 5_400 }),
        ride({ id: "4".repeat(64), localDate: "1998-06-20", movingSeconds: 4_800 }),
        ride({ id: "5".repeat(64), localDate: "1998-05-26", movingSeconds: 4_200 }),
      ],
      commits: [commit({ id: 1 })],
      scanTruncated: true,
    });

    expect(result.projection.kind).toBe("computed");
    if (result.projection.kind !== "computed") return;
    expect(result.projection.anchorWeek.coverage).toEqual({ kind: "complete" });
    expect(result.projection.anchorWeek.callout).toBeNull();
  });

  it("returns no callout when the unique winner falls outside the selected week", async () => {
    const result = await read({
      rows: [
        ride({ id: "1".repeat(64), localDate: "1998-07-08", movingSeconds: 6_000 }),
        ride({ id: "2".repeat(64), localDate: "1998-07-04", movingSeconds: 7_200 }),
        ride({ id: "3".repeat(64), localDate: "1998-06-28", movingSeconds: 5_400 }),
        ride({ id: "4".repeat(64), localDate: "1998-06-20", movingSeconds: 4_800 }),
      ],
      commits: [commit({ id: 1 })],
    });

    expect(result.projection.kind).toBe("computed");
    if (result.projection.kind !== "computed") return;
    expect(result.projection.anchorWeek.callout).toBeNull();
  });

  it("ends the current-week callout at the last elapsed covered day", async () => {
    const winner = ride({
      id: "1".repeat(64),
      localDate: "1998-07-08",
      movingSeconds: 7_200,
    });
    const result = await read({
      rows: [
        ride({ id: "5".repeat(64), localDate: "1998-07-11", movingSeconds: 9_000 }),
        winner,
        ride({ id: "2".repeat(64), localDate: "1998-07-04", movingSeconds: 6_000 }),
        ride({ id: "3".repeat(64), localDate: "1998-06-28", movingSeconds: 5_400 }),
        ride({ id: "4".repeat(64), localDate: "1998-06-20", movingSeconds: 4_800 }),
      ],
      commits: [
        commit({
          id: 1,
          newest: "1998-07-09",
          committedAt: "1998-07-10T08:00:00.000Z",
        }),
      ],
    });

    expect(result.projection.kind).toBe("computed");
    if (result.projection.kind !== "computed") return;
    expect(result.projection.anchorWeek.callout).toEqual({
      kind: "longest-ride-28d",
      rideId: winner.id,
      durationSeconds: 7_200,
      window: { start: "1998-06-12", end: "1998-07-09" },
      comparisonRideCount: 4,
    });
  });

  it("returns no callout in last-recorded display mode", async () => {
    const result = await read({
      rows: [
        ride({ id: "1".repeat(64), localDate: "1998-07-08", movingSeconds: 7_200 }),
        ride({ id: "2".repeat(64), localDate: "1998-07-04", movingSeconds: 6_000 }),
        ride({ id: "3".repeat(64), localDate: "1998-06-28", movingSeconds: 5_400 }),
        ride({ id: "4".repeat(64), localDate: "1998-06-20", movingSeconds: 4_800 }),
      ],
      commits: [commit({ id: 1 })],
      freshness: "stale",
    });

    expect(result.projection.kind).toBe("computed");
    if (result.projection.kind !== "computed") return;
    expect(result.projection.displayMode).toBe("last-recorded");
    expect(result.projection.anchorWeek.callout).toBeNull();
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
      undatedCount: 1,
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
        committedAt: DEFAULT_COMMITTED_AT,
      },
    });

    const incomplete = await read({
      commits: [
        clean,
        commit({
          id: 3,
          undatedCount: 1,
          committedAt: "1998-07-12T13:00:00.000Z",
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
        committedAt: "1998-07-12T13:00:00.000Z",
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
    expect(sparse.readLatestRideDate).toHaveBeenCalledWith({ through: "1998-07-12" });
    expect(sparse.readWindow).toHaveBeenCalledWith({
      start: "1998-04-13",
      end: "1998-05-31",
    });
  });

  it("localizes dated dropped rows to intersecting weeks", async () => {
    const result = await read({
      rows: [
        ride({ id: "1".repeat(64), localDate: "1998-07-08" }),
        ride({ id: "2".repeat(64), localDate: "1998-07-03" }),
      ],
      commits: [
        commit({
          id: 1,
          committedAt: "1998-07-11T12:00:00.000Z",
          datedLocalDates: ["1998-07-03"],
        }),
      ],
    });

    expect(result.projection.kind).toBe("computed");
    if (result.projection.kind !== "computed" || result.projection.previousWeek === null) return;
    expect(result.projection.anchorWeek.coverage).toEqual({ kind: "complete" });
    expect(result.projection.anchorWeek.rides.count).toEqual({ kind: "exact", value: 1 });
    expect(result.projection.previousWeek.coverage).toMatchObject({
      kind: "incomplete",
      reason: "source-degraded",
    });
    expect(result.projection.previousWeek.rides.count).toEqual({ kind: "at-least", value: 1 });
  });

  it("does not claim the open current day from coverage through yesterday", async () => {
    const result = await read({
      rows: [ride({ id: "1".repeat(64), localDate: "1998-07-10" })],
      commits: [
        commit({
          id: 1,
          newest: "1998-07-09",
          committedAt: "1998-07-10T12:00:00.000Z",
        }),
      ],
    });

    expect(result.projection.kind).toBe("computed");
    if (result.projection.kind !== "computed") return;
    expect(result.projection.anchorWeek.coverage).toMatchObject({
      kind: "incomplete",
      recordedThrough: "1998-07-09",
    });
    expect(result.projection.anchorWeek.rides.count).toEqual({ kind: "at-least", value: 1 });
    expect(result.projection.anchorWeek.callout).toBeNull();
  });

  it("clamps an existing same-day coverage claim when reading it", async () => {
    const result = await read({
      commits: [
        commit({
          id: 1,
          newest: "1998-07-10",
          committedAt: "1998-07-10T12:00:00.000Z",
        }),
      ],
    });

    expect(result.projection.kind).toBe("computed");
    if (result.projection.kind !== "computed") return;
    expect(result.projection.anchorWeek.coverage).toMatchObject({
      kind: "incomplete",
      recordedThrough: "1998-07-09",
    });
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
    expect(latestSafeRide.readLatestRideDate).toHaveBeenCalledWith({ through: "1998-07-12" });
    expect(latestSafeRide.readWindow).toHaveBeenCalledWith({
      start: "1998-04-13",
      end: "1998-05-31",
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
