import {
  FreshnessSchema,
  IsoInstantSchema,
  TrainingHistoryProjectionSchema,
  type CivilDateWindow,
  type CompletedActivityWeek,
  type DurationMetricValue,
  type Freshness,
  type RidingTimeTrend,
  type TrainingHistoryCoverage,
  type TrainingHistoryProjection,
  type TrainingHistoryRide,
  type WeekCoverage,
} from "@enduragent/coach-contract";
import { addCivilDays, mondayOfWeek, todayInTZ } from "@enduragent/engine/sport";
import {
  TrainingCoverageError,
  TrainingHistoryReadError,
  type CoverageCommitRow,
  type RecordedFact,
  type TrainingCoverageReader,
  type TrainingHistoryFactRow,
  type TrainingHistoryReader,
} from "@enduragent/kernel/store";

const MAX_VISIBLE_RIDES = 50;
const SPARSE_DISCOVERY_START = "1900-01-01";

interface WeekSlot {
  readonly window: CivilDateWindow;
  readonly rows: TrainingHistoryFactRow[];
}

interface ExpectedWindows {
  readonly anchor: CivilDateWindow;
  readonly previous: CivilDateWindow;
  readonly trend: readonly CivilDateWindow[];
  readonly slots: ReadonlyMap<string, WeekSlot>;
  readonly readWindow: CivilDateWindow;
}

type FoldedCoverage =
  | {
      readonly kind: "contiguous";
      readonly start: string;
      readonly through: string;
      readonly committedAt: string;
    }
  | {
      readonly kind: "incomplete";
      readonly provenStart: string | null;
      readonly provenThrough: string | null;
      readonly observedThrough: string | null;
      readonly committedAt: string | null;
      readonly reason: "source-degraded" | "undated-dropped-rows" | "coverage-timezone-changed";
    }
  | { readonly kind: "none" };

export interface TrainingHistorySource {
  readTrainingHistory(input: {
    readonly asOf: string;
    readonly asOfEpochSeconds: number;
    readonly calendarTimeZone: string;
    readonly freshness: Freshness;
    readonly sourceRestricted: boolean;
  }): Promise<TrainingHistoryProjection>;
}

function unavailable(
  reason: "coverage-unavailable" | "temporary-failure" | "invalid-data",
): TrainingHistoryProjection {
  return TrainingHistoryProjectionSchema.parse({ kind: "unavailable", reason });
}

function instantFromEpochSeconds(value: number): string {
  return new Date(value * 1_000).toISOString();
}

function utcCivilDateFromEpochSeconds(value: number): string {
  const date = new Date(value * 1_000);
  const year = date.getUTCFullYear();
  if (!Number.isFinite(date.getTime()) || year < 0 || year > 9_999) {
    throw new TypeError("invalid epoch seconds");
  }
  return `${String(year).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function mergeCleanCoverage(rows: readonly CoverageCommitRow[]): {
  readonly start: string;
  readonly through: string;
} {
  const latest = rows.at(-1);
  if (latest === undefined) throw new TypeError("clean coverage is empty");
  let start = latest.coveredOldest;
  let through = latest.coveredNewest;
  for (let index = rows.length - 2; index >= 0; index -= 1) {
    const row = rows.at(index);
    if (row === undefined) throw new TypeError("coverage row is missing");
    if (row.gapState !== "none") {
      if (row.coveredOldest >= start && row.coveredNewest <= through) continue;
      break;
    }
    if (
      row.coveredNewest < addCivilDays(start, -1) ||
      row.coveredOldest > addCivilDays(through, 1)
    ) {
      continue;
    }
    if (row.coveredOldest < start) start = row.coveredOldest;
    if (row.coveredNewest > through) through = row.coveredNewest;
  }
  return { start, through };
}

function foldCoverage(
  commits: readonly CoverageCommitRow[],
  calendarTimeZone: string,
  sourceRestricted: boolean,
): FoldedCoverage {
  const matching = commits.filter((commit) => commit.calendarTimeZone === calendarTimeZone);
  const latestOverall = commits.at(-1);
  const latestMatching = matching.at(-1);
  const clean = matching.filter((commit) => commit.gapState === "none");
  const latestClean = clean.at(-1);
  const proven = latestClean === undefined ? null : mergeCleanCoverage(clean);
  if (sourceRestricted) {
    return {
      kind: "incomplete",
      provenStart: proven?.start ?? null,
      provenThrough: proven?.through ?? null,
      observedThrough: latestMatching?.coveredNewest ?? null,
      committedAt:
        latestMatching === undefined
          ? null
          : instantFromEpochSeconds(latestMatching.committedEpochSeconds),
      reason: "source-degraded",
    };
  }
  if (latestOverall !== undefined && latestOverall.calendarTimeZone !== calendarTimeZone) {
    return {
      kind: "incomplete",
      provenStart: proven?.start ?? null,
      provenThrough: proven?.through ?? null,
      observedThrough: latestOverall.coveredNewest,
      committedAt: instantFromEpochSeconds(latestOverall.committedEpochSeconds),
      reason: "coverage-timezone-changed",
    };
  }
  if (latestMatching === undefined) return { kind: "none" };
  if (latestMatching.gapState === "undated-dropped-rows") {
    return {
      kind: "incomplete",
      provenStart: proven?.start ?? null,
      provenThrough: proven?.through ?? null,
      observedThrough: latestMatching.coveredNewest,
      committedAt: instantFromEpochSeconds(latestMatching.committedEpochSeconds),
      reason: "undated-dropped-rows",
    };
  }
  const current = mergeCleanCoverage(matching);
  return {
    kind: "contiguous",
    start: current.start,
    through: current.through,
    committedAt: instantFromEpochSeconds(latestMatching.committedEpochSeconds),
  };
}

function weekWindow(date: string): CivilDateWindow {
  const start = mondayOfWeek(date);
  return { start, end: addCivilDays(start, 6) };
}

function expectedWindows(
  anchorDate: string,
  today: string,
  displayMode: "current" | "last-recorded",
): ExpectedWindows {
  const anchor = weekWindow(anchorDate);
  const previous = weekWindow(addCivilDays(anchor.start, -1));
  const anchorOpen = today >= anchor.start && today <= anchor.end;
  const newestTrendStart = displayMode === "current" && !anchorOpen ? anchor.start : previous.start;
  const trend = Array.from({ length: 6 }, (_, index) => {
    const start = addCivilDays(newestTrendStart, (index - 5) * 7);
    return { start, end: addCivilDays(start, 6) };
  });
  const windows = [anchor, previous, ...trend];
  const slots = new Map<string, WeekSlot>();
  for (const window of windows) {
    if (!slots.has(window.start)) slots.set(window.start, { window, rows: [] });
  }
  const starts = windows.map((window) => window.start).sort();
  const ends = windows.map((window) => window.end).sort();
  const readStart = starts.at(0);
  const readEnd = ends.at(-1);
  if (readStart === undefined || readEnd === undefined) {
    throw new TypeError("expected training history windows are empty");
  }
  return {
    anchor,
    previous,
    trend,
    slots,
    readWindow: { start: readStart, end: readEnd },
  };
}

function safeCoverageAnchor(coverage: FoldedCoverage): string | null {
  if (coverage.kind === "contiguous") return coverage.through;
  if (coverage.kind === "incomplete") {
    if (coverage.provenThrough !== null) return coverage.provenThrough;
    if (coverage.reason !== "coverage-timezone-changed") return coverage.observedThrough;
  }
  return null;
}

function latestRideDate(rows: readonly TrainingHistoryFactRow[]): string | null {
  let latest: string | null = null;
  for (const row of rows) if (latest === null || row.localDate > latest) latest = row.localDate;
  return latest;
}

function scanCutoffDate(
  rows: readonly TrainingHistoryFactRow[],
  scanTruncated: boolean,
): string | null {
  if (!scanTruncated) return null;
  const oldestReturned = rows.at(-1);
  if (oldestReturned === undefined) throw new TypeError("truncated scan has no rows");
  return addCivilDays(utcCivilDateFromEpochSeconds(oldestReturned.startEpochSeconds), 1);
}

function projectionCoverage(
  coverage: FoldedCoverage,
  sparseRideDate: string | null,
): TrainingHistoryCoverage | null {
  if (coverage.kind === "contiguous") return coverage;
  if (coverage.kind === "incomplete") return coverage;
  if (sparseRideDate === null) return null;
  return {
    kind: "sparse",
    latestKnownRideDate: sparseRideDate,
    latestImportAt: null,
  };
}

function assignRows(windows: ExpectedWindows, rows: readonly TrainingHistoryFactRow[]): void {
  for (const row of rows) {
    const slot = windows.slots.get(mondayOfWeek(row.localDate));
    if (slot !== undefined) slot.rows.push(row);
  }
  for (const slot of windows.slots.values()) {
    slot.rows.sort(
      (left, right) =>
        right.startEpochSeconds - left.startEpochSeconds || left.id.localeCompare(right.id),
    );
  }
}

function recordedCoreFact(value: number | null): RecordedFact<number> {
  return value === null ? { kind: "absent" } : { kind: "recorded", value };
}

function aggregateMetric(
  facts: readonly RecordedFact<number>[],
  coverageComplete: boolean,
): DurationMetricValue {
  if (facts.length === 0) {
    return coverageComplete
      ? { kind: "computed", value: 0 }
      : { kind: "unavailable", reason: "incomplete-coverage" };
  }
  const recorded = facts.filter(
    (fact): fact is Extract<RecordedFact<number>, { readonly kind: "recorded" }> =>
      fact.kind === "recorded",
  );
  const value = recorded.reduce((sum, fact) => sum + fact.value, 0);
  if (!coverageComplete) {
    return recorded.length === 0
      ? { kind: "unavailable", reason: "incomplete-coverage" }
      : { kind: "partial", value, reason: "incomplete-coverage" };
  }
  if (recorded.length === facts.length) return { kind: "computed", value };
  if (recorded.length > 0) {
    return {
      kind: "partial",
      value,
      reason: "missing-recorded-value",
      knownRideMissingValueCount: facts.length - recorded.length,
    };
  }
  return facts.some((fact) => fact.kind === "rejected")
    ? { kind: "unavailable", reason: "invalid-recorded-value" }
    : { kind: "unavailable", reason: "no-recorded-value" };
}

function ridingTime(row: TrainingHistoryFactRow): {
  readonly seconds: number | null;
  readonly basis: "moving" | "elapsed" | null;
} {
  if (row.movingSeconds !== null) return { seconds: row.movingSeconds, basis: "moving" };
  if (row.elapsedSeconds !== null) return { seconds: row.elapsedSeconds, basis: "elapsed" };
  return { seconds: null, basis: null };
}

function recordedValue(fact: RecordedFact<number>): number | null {
  return fact.kind === "recorded" ? fact.value : null;
}

function projectRide(row: TrainingHistoryFactRow): TrainingHistoryRide {
  const riding = ridingTime(row);
  return {
    id: row.id,
    title: row.title,
    subSport: row.subSport,
    startEpochSeconds: row.startEpochSeconds,
    timezoneOffsetSeconds: row.timezoneOffsetSeconds,
    localDate: row.localDate,
    ridingSeconds: riding.seconds,
    ridingTimeBasis: riding.basis,
    elapsedSeconds: row.elapsedSeconds,
    distanceMeters: row.distanceMeters,
    load: recordedValue(row.load),
    averagePowerWatts: recordedValue(row.averagePowerWatts),
    averageHeartRateBpm: recordedValue(row.averageHeartRateBpm),
    perceivedExertion: recordedValue(row.perceivedExertion),
    energyKilojoules: recordedValue(row.energyKilojoules),
  };
}

function longestRecordedRideCallout(input: {
  readonly selectedWeek: CivilDateWindow;
  readonly rows: readonly TrainingHistoryFactRow[];
  readonly returnedRides: readonly TrainingHistoryRide[];
  readonly coverage: TrainingHistoryCoverage;
  readonly scanTruncated: boolean;
  readonly displayMode: "current" | "last-recorded";
}): CompletedActivityWeek["callout"] {
  if (
    input.displayMode === "last-recorded" ||
    input.scanTruncated ||
    input.coverage.kind !== "contiguous"
  ) {
    return null;
  }
  const end =
    input.coverage.through < input.selectedWeek.end
      ? input.coverage.through
      : input.selectedWeek.end;
  const window = { start: addCivilDays(end, -27), end };
  if (input.coverage.start > window.start) return null;
  const rows = input.rows.filter(
    (row) => row.localDate >= window.start && row.localDate <= window.end,
  );
  if (rows.length < 4 || rows.length > 1_000) return null;
  let longest: { readonly row: TrainingHistoryFactRow; readonly durationSeconds: number } | null =
    null;
  let tied = false;
  for (const row of rows) {
    const durationSeconds = ridingTime(row).seconds;
    if (durationSeconds === null) return null;
    if (longest === null || durationSeconds > longest.durationSeconds) {
      longest = { row, durationSeconds };
      tied = false;
    } else if (durationSeconds === longest.durationSeconds) {
      tied = true;
    }
  }
  if (
    longest === null ||
    tied ||
    longest.row.localDate < input.selectedWeek.start ||
    longest.row.localDate > input.selectedWeek.end
  ) {
    return null;
  }
  const returnedRide = input.returnedRides.find((ride) => ride.id === longest.row.id);
  if (returnedRide?.ridingSeconds !== longest.durationSeconds) return null;
  return {
    kind: "longest-ride-28d",
    rideId: longest.row.id,
    durationSeconds: longest.durationSeconds,
    window,
    comparisonRideCount: rows.length,
  };
}

function calendarState(
  window: CivilDateWindow,
  today: string,
): CompletedActivityWeek["calendarState"] {
  return today >= window.start && today <= window.end ? "open" : "closed";
}

function recordedThrough(coverage: TrainingHistoryCoverage): string | null {
  if (coverage.kind === "contiguous") return coverage.through;
  if (coverage.kind === "incomplete") {
    return coverage.provenThrough ?? coverage.observedThrough;
  }
  return coverage.latestKnownRideDate;
}

function weekCoverage(input: {
  readonly window: CivilDateWindow;
  readonly today: string;
  readonly coverage: TrainingHistoryCoverage;
  readonly scanCutoffDate: string | null;
  readonly currentAnchor: boolean;
}): WeekCoverage {
  const through = recordedThrough(input.coverage);
  if (input.scanCutoffDate !== null && input.window.start <= input.scanCutoffDate) {
    return { kind: "incomplete", recordedThrough: through, reason: "scan-limit" };
  }
  if (input.coverage.kind === "sparse") {
    return { kind: "incomplete", recordedThrough: through, reason: "sparse-imports" };
  }
  if (input.coverage.kind === "incomplete") {
    const reason =
      input.coverage.reason === "coverage-timezone-changed"
        ? "coverage-timezone-changed"
        : input.coverage.reason === "source-degraded" ||
            input.coverage.reason === "undated-dropped-rows"
          ? "source-degraded"
          : "backfill-incomplete";
    return { kind: "incomplete", recordedThrough: through, reason };
  }
  const open = calendarState(input.window, input.today) === "open";
  const covered =
    input.coverage.start <= input.window.start &&
    input.coverage.through >= (open ? input.window.start : input.window.end);
  if (covered) return { kind: "complete" };
  return {
    kind: "incomplete",
    recordedThrough: input.coverage.through,
    reason:
      input.currentAnchor && input.coverage.through < input.window.start
        ? "coverage-lag"
        : "backfill-incomplete",
  };
}

function rideCountMetric(
  count: number,
  complete: boolean,
): CompletedActivityWeek["totals"]["rideCount"] {
  if (complete) return { kind: "computed", value: count };
  return count === 0
    ? { kind: "unavailable", reason: "incomplete-coverage" }
    : { kind: "partial", value: count, reason: "incomplete-coverage" };
}

function trend(input: {
  readonly windows: ExpectedWindows;
  readonly today: string;
  readonly coverage: TrainingHistoryCoverage;
  readonly scanCutoffDate: string | null;
}): RidingTimeTrend {
  const buckets = input.windows.trend.map((window) => {
    const slot = input.windows.slots.get(window.start);
    if (slot === undefined) throw new TypeError("trend window is missing");
    const coverage = weekCoverage({
      window,
      today: input.today,
      coverage: input.coverage,
      scanCutoffDate: input.scanCutoffDate,
      currentAnchor: false,
    });
    return { slot, coverage };
  });
  const incomplete = buckets.filter((bucket) => bucket.coverage.kind === "incomplete");
  if (
    incomplete.some(
      (bucket) =>
        bucket.coverage.kind === "incomplete" &&
        (bucket.coverage.reason === "source-degraded" ||
          bucket.coverage.reason === "coverage-timezone-changed" ||
          bucket.coverage.reason === "sparse-imports" ||
          bucket.coverage.reason === "scan-limit" ||
          bucket.coverage.reason === "invalid-core-record"),
    )
  ) {
    return { kind: "unavailable", reason: "incomplete-source" };
  }
  if (incomplete.length > 0) return { kind: "unavailable", reason: "limited-history" };
  if (buckets.some(({ slot }) => slot.rows.some((row) => ridingTime(row).seconds === null))) {
    return { kind: "unavailable", reason: "missing-duration" };
  }
  return {
    kind: "computed",
    buckets: buckets.map(({ slot }) => ({
      window: slot.window,
      rideCount: slot.rows.length,
      ridingSeconds: slot.rows.reduce((sum, row) => sum + (ridingTime(row).seconds ?? 0), 0),
    })),
  };
}

function completedWeek(input: {
  readonly id: "anchor" | "previous";
  readonly window: CivilDateWindow;
  readonly windows: ExpectedWindows;
  readonly today: string;
  readonly coverage: TrainingHistoryCoverage;
  readonly scanCutoffDate: string | null;
  readonly trend: RidingTimeTrend;
}): CompletedActivityWeek {
  const slot = input.windows.slots.get(input.window.start);
  if (slot === undefined) throw new TypeError("completed week is missing");
  const coverage = weekCoverage({
    window: input.window,
    today: input.today,
    coverage: input.coverage,
    scanCutoffDate: input.scanCutoffDate,
    currentAnchor: input.id === "anchor",
  });
  const complete = coverage.kind === "complete";
  const items = slot.rows.slice(0, MAX_VISIBLE_RIDES).map(projectRide);
  const scanLimited = input.scanCutoffDate !== null && input.window.start <= input.scanCutoffDate;
  const truncated = scanLimited || slot.rows.length > items.length;
  return {
    id: input.id,
    window: input.window,
    calendarState: calendarState(input.window, input.today),
    coverage,
    totals: {
      rideCount: rideCountMetric(slot.rows.length, complete),
      ridingSeconds: aggregateMetric(
        slot.rows.map((row) => recordedCoreFact(ridingTime(row).seconds)),
        complete,
      ),
      distanceMeters: aggregateMetric(
        slot.rows.map((row) => recordedCoreFact(row.distanceMeters)),
        complete,
      ),
      load: aggregateMetric(
        slot.rows.map((row) => row.load),
        complete,
      ),
    },
    rides: {
      count: scanLimited
        ? { kind: "at-least", value: slot.rows.length }
        : { kind: "exact", value: slot.rows.length },
      items,
      truncated,
    },
    trend: input.trend,
    callout: null,
  };
}

function invalidInput(input: Parameters<TrainingHistorySource["readTrainingHistory"]>[0]): boolean {
  if (!IsoInstantSchema.safeParse(input.asOf).success) return true;
  if (!FreshnessSchema.safeParse(input.freshness).success) return true;
  if (!Number.isSafeInteger(input.asOfEpochSeconds) || input.asOfEpochSeconds < 0) return true;
  return !Number.isFinite(new Date(input.asOfEpochSeconds * 1_000).getTime());
}

function dependencyFailure(error: unknown): TrainingHistoryProjection {
  return unavailable(
    error instanceof TrainingHistoryReadError || error instanceof TrainingCoverageError
      ? "invalid-data"
      : "temporary-failure",
  );
}

export function createTrainingHistorySource(dependencies: {
  readonly facts: TrainingHistoryReader;
  readonly coverage: TrainingCoverageReader;
}): TrainingHistorySource {
  if (
    dependencies === null ||
    typeof dependencies !== "object" ||
    dependencies.facts === null ||
    typeof dependencies.facts !== "object" ||
    typeof dependencies.facts.readWindow !== "function" ||
    dependencies.coverage === null ||
    typeof dependencies.coverage !== "object" ||
    typeof dependencies.coverage.listCommits !== "function"
  ) {
    throw new TypeError("training history dependencies are invalid");
  }
  return Object.freeze({
    async readTrainingHistory(
      input: Parameters<TrainingHistorySource["readTrainingHistory"]>[0],
    ): Promise<TrainingHistoryProjection> {
      if (input === null || typeof input !== "object" || invalidInput(input)) {
        return unavailable("invalid-data");
      }
      let today: string;
      try {
        today = todayInTZ(input.calendarTimeZone, new Date(input.asOfEpochSeconds * 1_000));
      } catch {
        return unavailable("invalid-data");
      }
      let commits: readonly CoverageCommitRow[];
      try {
        commits = await dependencies.coverage.listCommits({
          source: "intervals-icu",
          lane: "activities",
        });
      } catch (error) {
        return dependencyFailure(error);
      }
      let folded: FoldedCoverage;
      try {
        folded = foldCoverage(commits, input.calendarTimeZone, input.sourceRestricted);
      } catch {
        return unavailable("invalid-data");
      }
      const currentAnchor = mondayOfWeek(today);
      const retainedAnchor = safeCoverageAnchor(folded);
      const lastRecorded = input.freshness !== "fresh" && input.freshness !== "flag";
      const discoverSparseHistory =
        folded.kind === "none" || (lastRecorded && retainedAnchor === null);
      const provisionalAnchor = lastRecorded ? (retainedAnchor ?? today) : currentAnchor;
      const provisionalDisplayMode = lastRecorded ? "last-recorded" : "current";
      let windows = expectedWindows(provisionalAnchor, today, provisionalDisplayMode);
      const factsWindow = discoverSparseHistory
        ? { start: SPARSE_DISCOVERY_START, end: windows.readWindow.end }
        : windows.readWindow;
      let facts: Awaited<ReturnType<TrainingHistoryReader["readWindow"]>>;
      try {
        facts = await dependencies.facts.readWindow(factsWindow);
      } catch (error) {
        return dependencyFailure(error);
      }
      if (facts.scanTruncated && facts.rows.length === 0) return unavailable("invalid-data");
      const sparseRideDate = latestRideDate(facts.rows);
      if (lastRecorded && retainedAnchor === null && sparseRideDate === null) {
        return unavailable("coverage-unavailable");
      }
      const coverage = projectionCoverage(folded, sparseRideDate);
      if (coverage === null) return unavailable("coverage-unavailable");
      let anchorDate = provisionalAnchor;
      let displayMode: "current" | "last-recorded" = provisionalDisplayMode;
      if (coverage.kind === "sparse") {
        anchorDate = coverage.latestKnownRideDate;
        displayMode = "last-recorded";
      } else if (lastRecorded) {
        anchorDate = retainedAnchor ?? sparseRideDate ?? provisionalAnchor;
      }
      if (mondayOfWeek(anchorDate) !== windows.anchor.start) {
        windows = expectedWindows(anchorDate, today, displayMode);
      }
      try {
        assignRows(windows, facts.rows);
        const scanCutoff = scanCutoffDate(facts.rows, facts.scanTruncated);
        const ridingTrend = trend({
          windows,
          today,
          coverage,
          scanCutoffDate: scanCutoff,
        });
        const anchorWeekWithoutCallout = completedWeek({
          id: "anchor",
          window: windows.anchor,
          windows,
          today,
          coverage,
          scanCutoffDate: scanCutoff,
          trend: ridingTrend,
        });
        const anchorWeek: CompletedActivityWeek = {
          ...anchorWeekWithoutCallout,
          callout: longestRecordedRideCallout({
            selectedWeek: windows.anchor,
            rows: facts.rows,
            returnedRides: anchorWeekWithoutCallout.rides.items,
            coverage,
            scanTruncated: facts.scanTruncated,
            displayMode,
          }),
        };
        const projection: TrainingHistoryProjection = {
          kind: "computed",
          asOf: input.asOf,
          calendarTimeZone: input.calendarTimeZone,
          displayMode,
          coverage,
          anchorWeek,
          previousWeek: completedWeek({
            id: "previous",
            window: windows.previous,
            windows,
            today,
            coverage,
            scanCutoffDate: scanCutoff,
            trend: ridingTrend,
          }),
        };
        return TrainingHistoryProjectionSchema.parse(projection);
      } catch (error) {
        if (error instanceof TypeError) throw error;
        return unavailable("invalid-data");
      }
    },
  });
}
